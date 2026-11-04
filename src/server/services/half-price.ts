// Reserva automática da cota legal de meia-entrada (L7c) — acesso ao banco.
// O cálculo é puro (src/features/half-price/quota.ts). A liberação da cota vale
// pelo relógio em todo lugar; `recordHalfPriceReleases` (cron) só registra.
import "server-only";
import type { HalfPriceRegime, Prisma } from "@/generated/prisma/client";
import { computeHalfPriceState, releaseAtOf, type HalfPriceEventInput, type HalfPriceState, type HalfPriceTypeInput } from "@/features/half-price/quota";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { assertPlatformAdmin, type Actor } from "../auth/permissions";
import { AppError, notFound } from "../errors";

/** Campos do Event (com o local) que a regra usa. */
export const HALF_PRICE_EVENT_SELECT = {
  id: true,
  organizationId: true,
  timezone: true,
  capacity: true,
  startsAt: true,
  locationType: true,
  halfPriceQuotaBps: true,
  halfPriceRegime: true,
  halfPriceRegimeNote: true,
  halfPriceReleaseAuditedFor: true,
  venue: { select: { capacity: true } },
} satisfies Prisma.EventSelect;

export const HALF_PRICE_TYPE_SELECT = {
  id: true,
  kind: true,
  priceCents: true,
  isHidden: true,
  quantityTotal: true,
  quantityReserved: true,
  quantitySold: true,
} satisfies Prisma.TicketTypeSelect;

type EventForHalfPrice = Pick<Prisma.EventGetPayload<{ select: typeof HALF_PRICE_EVENT_SELECT }>, "capacity" | "startsAt" | "halfPriceQuotaBps" | "halfPriceRegime"> & {
  locationType?: "VENUE" | "ONLINE";
  venue?: { capacity: number | null } | null;
};

/** Entrada do cálculo a partir da linha do evento. Online (ou local sem capacidade) → capacidade do evento. */
export function halfPriceEventInput(event: EventForHalfPrice): HalfPriceEventInput {
  return {
    capacity: event.capacity,
    startsAt: event.startsAt,
    halfPriceQuotaBps: event.halfPriceQuotaBps,
    halfPriceRegime: event.halfPriceRegime,
    venueCapacity: event.locationType === "ONLINE" ? null : (event.venue?.capacity ?? null),
  };
}

export interface HalfPriceContext {
  event: Prisma.EventGetPayload<{ select: typeof HALF_PRICE_EVENT_SELECT }>;
  input: HalfPriceEventInput;
  types: HalfPriceTypeInput[];
  state: HalfPriceState;
}

/**
 * Evento + local + tipos e o estado calculado. Para o resultado valer numa decisão
 * (pedido, mudança de estoque), chame com a trava do evento (`lockEvent`) tomada.
 */
export async function loadHalfPriceStateTx(client: Db | Tx, eventId: string, now = new Date()): Promise<HalfPriceContext> {
  const row = await client.event.findUnique({
    where: { id: eventId },
    select: { ...HALF_PRICE_EVENT_SELECT, ticketTypes: { select: HALF_PRICE_TYPE_SELECT, orderBy: { sortOrder: "asc" } } },
  });
  if (!row) throw notFound("Evento não encontrado.");
  const { ticketTypes, ...event } = row;
  const input = halfPriceEventInput(event);
  return { event, input, types: ticketTypes, state: computeHalfPriceState(input, ticketTypes, now) };
}

/** Metadados de auditoria (JSON): números da cota no instante da decisão. */
export function halfPriceSnapshot(state: HalfPriceState) {
  return {
    status: state.status,
    applicable: state.applicable,
    notApplicableReason: state.notApplicableReason,
    reserveActive: state.reserveActive,
    eligibleStock: state.eligibleStock,
    quota: state.quota,
    halfLimit: Number.isFinite(state.halfLimit) ? state.halfLimit : null,
    halfSold: state.halfSold,
    halfReserved: state.halfReserved,
    fullSold: state.fullSold,
    fullReserved: state.fullReserved,
    nonEligibleCommitted: state.nonEligibleCommitted,
    balance: state.balance,
    blocked: state.blocked,
    violation: state.violation,
    eventCapacity: state.eventCapacity,
    physicalCapacity: state.physicalCapacity,
    deadlineHours: state.deadlineHours,
    releaseAt: state.releaseAt.toISOString(),
  };
}

const RELEASE_LOOKAHEAD_MS = 72 * 3_600_000;

/**
 * Cron: registra (uma vez por `releaseAt`) a liberação da cota de cada evento cujo
 * prazo passou. Idempotente pelo marcador `halfPriceReleaseAuditedFor` (updateMany
 * condicional + audit na mesma transação). Se a data/local muda, a `releaseAt` muda e o
 * registro rearma. Nunca é a garantia: a regra libera pelo relógio, com ou sem o cron.
 */
export async function recordHalfPriceReleases(db: Db, now = new Date()): Promise<number> {
  const candidates = await db.event.findMany({
    where: { status: "PUBLISHED", halfPriceRegime: "FEDERAL", startsAt: { lte: new Date(now.getTime() + RELEASE_LOOKAHEAD_MS) }, endsAt: { gt: now } },
    select: { id: true, capacity: true, startsAt: true, locationType: true, venue: { select: { capacity: true } }, halfPriceReleaseAuditedFor: true },
    take: 500,
  });
  let recorded = 0;
  for (const c of candidates) {
    // Filtro sem trava (a cada minuto): só trava o evento cujo prazo passou e ainda não foi registrado.
    const { releaseAt } = releaseAtOf({ startsAt: c.startsAt, capacity: c.capacity, venueCapacity: c.locationType === "ONLINE" ? null : (c.venue?.capacity ?? null) });
    if (releaseAt > now || c.halfPriceReleaseAuditedFor?.getTime() === releaseAt.getTime()) continue;
    const { id } = c;
    recorded += await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${id} FOR UPDATE`;
      const { event, state } = await loadHalfPriceStateTx(tx, id, now);
      if (!state.applicable || state.reserveActive) return 0;
      const { count } = await tx.event.updateMany({
        where: { id, OR: [{ halfPriceReleaseAuditedFor: null }, { halfPriceReleaseAuditedFor: { not: state.releaseAt } }] },
        data: { halfPriceReleaseAuditedFor: state.releaseAt },
      });
      if (!count) return 0;
      await audit(tx, {
        organizationId: event.organizationId,
        action: "half_price.quota_released",
        entityType: "Event",
        entityId: id,
        metadata: { ...halfPriceSnapshot(state), recordedAt: now.toISOString(), previousReleaseAt: event.halfPriceReleaseAuditedFor?.toISOString() ?? null },
      });
      return 1;
    }, TX_OPTIONS);
  }
  return recorded;
}

const NOTE_MAX = 500;

/**
 * Só o admin da plataforma define o regime (o organizador nunca desliga a reserva).
 * `NOT_SUBJECT` exige o motivo/base legal na nota. Auditado com o estado antes/depois.
 */
export async function setHalfPriceRegime(db: Db, admin: Actor, eventId: string, regime: HalfPriceRegime, note: string | null | undefined, now = new Date()) {
  assertPlatformAdmin(admin);
  if (regime !== "FEDERAL" && regime !== "NOT_SUBJECT") throw new AppError("VALIDATION", "Regime de meia-entrada inválido.");
  const text = note?.trim() || null;
  if (text && text.length > NOTE_MAX) throw new AppError("VALIDATION", `A justificativa pode ter até ${NOTE_MAX} caracteres.`);
  if (regime === "NOT_SUBJECT" && !text) throw new AppError("VALIDATION", "Informe o motivo e a base legal para dispensar a cota de meia-entrada.");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    const before = await loadHalfPriceStateTx(tx, eventId, now);
    if (before.event.halfPriceRegime === regime && before.event.halfPriceRegimeNote === text) return before.event;
    await tx.event.update({ where: { id: eventId }, data: { halfPriceRegime: regime, halfPriceRegimeNote: text } });
    const after = await loadHalfPriceStateTx(tx, eventId, now);
    await audit(tx, {
      actorUserId: admin.id,
      organizationId: before.event.organizationId,
      action: "half_price.regime_changed",
      entityType: "Event",
      entityId: eventId,
      metadata: {
        from: before.event.halfPriceRegime,
        to: regime,
        previousNote: before.event.halfPriceRegimeNote,
        note: text,
        before: halfPriceSnapshot(before.state),
        after: halfPriceSnapshot(after.state),
      },
    });
    return after.event;
  }, TX_OPTIONS);
}
