// Alterações relevantes de evento com vendas (R8): histórico somente inserção
// (`EventChange`), janela de reembolso integral e prorrogação. A elegibilidade do
// reembolso é do `pagamentos-financeiro` (refundEligibility); aqui só gravamos.
// Regras provisórias (D2) em src/features/organizer/event-change-rules.ts.
import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import {
  CHANGE_REASON_MAX,
  CHANGE_REASON_MIN,
  CHANGE_REASON_REQUIRED,
  refundUntilFor,
  relevantChangedFields,
  type LocationSnapshot,
} from "@/features/organizer/event-change-rules";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { assertEventPermission, type Actor } from "../auth/permissions";
import { AppError, invalidState, notFound } from "../errors";
import { notifyEventChange, notifyEventChangeInBackground } from "./notifications";

/** Retrato do que é relevante, sem dados pessoais (o link online fica de fora: só compradores o recebem). */
async function snapshot(tx: Tx, s: LocationSnapshot) {
  const [venue, city] = await Promise.all([
    s.venueId ? tx.venue.findUnique({ where: { id: s.venueId }, select: { name: true } }) : null,
    s.cityId ? tx.city.findUnique({ where: { id: s.cityId }, select: { name: true, state: true } }) : null,
  ]);
  return {
    startsAt: s.startsAt.toISOString(),
    locationType: s.locationType,
    venueId: s.venueId,
    venueName: venue?.name ?? null,
    cityId: s.cityId,
    cityName: city ? `${city.name} – ${city.state}` : null,
  };
}

export function normalizeChangeReason(reason: string | undefined): string {
  const r = reason?.trim() ?? "";
  if (!r) throw new AppError("VALIDATION", CHANGE_REASON_REQUIRED);
  if (r.length < CHANGE_REASON_MIN) throw new AppError("VALIDATION", `Descreva o motivo com pelo menos ${CHANGE_REASON_MIN} caracteres.`);
  if (r.length > CHANGE_REASON_MAX) throw new AppError("VALIDATION", `O motivo pode ter no máximo ${CHANGE_REASON_MAX} caracteres.`);
  return r;
}

/**
 * Dentro da transação de `updateEvent` (com o evento travado): se a edição de um evento
 * PUBLICADO com pedido pago for relevante, exige motivo e grava a `EventChange` com a
 * janela de reembolso. Devolve null para edição comum.
 */
export async function recordRelevantChange(
  tx: Tx,
  args: { actorUserId: string; event: LocationSnapshot & { id: string; organizationId: string; status: string }; next: LocationSnapshot; reason: string | undefined },
) {
  const { event, next } = args;
  if (event.status !== "PUBLISHED") return null;
  const fields = relevantChangedFields(event, next);
  if (!fields.length) return null;
  if (!(await tx.order.count({ where: { eventId: event.id, status: "PAID" } }))) return null;
  const reason = normalizeChangeReason(args.reason);
  // Instante explícito: o mesmo valor vale para o CHECK (refundUntil > createdAt) e
  // para a regra "pedidos pagos antes da alteração".
  const now = new Date();
  if (next.startsAt <= now) throw new AppError("VALIDATION", "O novo início precisa ser no futuro: os compradores têm direito a uma janela de reembolso antes do evento.");
  const change = await tx.eventChange.create({
    data: {
      eventId: event.id,
      organizationId: event.organizationId,
      actorUserId: args.actorUserId,
      changedFields: fields,
      before: await snapshot(tx, event),
      after: await snapshot(tx, next),
      reason,
      relevant: true,
      refundUntil: refundUntilFor(now, next.startsAt),
      createdAt: now,
    },
  });
  await audit(tx, {
    actorUserId: args.actorUserId,
    organizationId: event.organizationId,
    action: "event.relevant_change",
    entityType: "EventChange",
    entityId: change.id,
    metadata: { eventId: event.id, changedFields: fields, refundUntil: change.refundUntil!.toISOString() },
  });
  await notifyEventChange(tx, change.id);
  return change;
}

/** Prazo vigente de uma alteração: o maior entre ela e suas prorrogações. */
async function effectiveRefundUntil(client: Db | Tx, rootId: string): Promise<Date | null> {
  const agg = await client.eventChange.aggregate({ where: { OR: [{ id: rootId }, { extendsChangeId: rootId }] }, _max: { refundUntil: true } });
  return agg._max.refundUntil;
}

/**
 * Prorroga a janela de reembolso de uma alteração ainda aberta. Grava nova linha com
 * `extendsChangeId` apontando sempre para a alteração original.
 */
export async function extendEventChangeWindow(db: Db, actor: Actor, changeId: string, raw: { refundUntil: Date; reason: string }) {
  const found = await db.eventChange.findUnique({ where: { id: changeId }, select: { eventId: true } });
  if (!found) throw notFound("Alteração não encontrada.");
  const { organizationId } = await assertEventPermission(db, actor, found.eventId, "event:write");
  const reason = normalizeChangeReason(raw.reason);
  if (Number.isNaN(raw.refundUntil.getTime())) throw new AppError("VALIDATION", "Data do novo prazo inválida.");
  const extension = await db.$transaction(async (tx) => {
    // Mesma trava de updateEvent: prorrogações e alterações do evento ficam em série.
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${found.eventId} FOR UPDATE`;
    const event = await tx.event.findUniqueOrThrow({ where: { id: found.eventId } });
    const target = await tx.eventChange.findUniqueOrThrow({ where: { id: changeId } });
    const rootId = target.extendsChangeId ?? target.id;
    const root = rootId === target.id ? target : await tx.eventChange.findUniqueOrThrow({ where: { id: rootId } });
    if (!root.refundUntil) throw invalidState("Esta alteração não abriu janela de reembolso.");
    const current = (await effectiveRefundUntil(tx, rootId))!;
    const now = new Date();
    if (current <= now) throw invalidState("A janela de reembolso desta alteração já terminou.");
    if (!["PUBLISHED", "PENDING_REVIEW", "DRAFT"].includes(event.status)) throw invalidState("Este evento não pode mais ser alterado.");
    if (raw.refundUntil <= current) throw new AppError("VALIDATION", "O novo prazo precisa ser depois do prazo atual.");
    if (raw.refundUntil > event.startsAt) throw new AppError("VALIDATION", "O prazo de reembolso não pode passar do início do evento.");
    const extension = await tx.eventChange.create({
      data: {
        eventId: event.id,
        organizationId,
        actorUserId: actor.id,
        changedFields: [],
        before: { refundUntil: current.toISOString() },
        after: { refundUntil: raw.refundUntil.toISOString() },
        reason,
        relevant: true,
        refundUntil: raw.refundUntil,
        extendsChangeId: rootId,
        createdAt: now,
      },
    });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "event.change_window_extended",
      entityType: "EventChange",
      entityId: extension.id,
      metadata: { eventId: event.id, extendsChangeId: rootId, from: current.toISOString(), to: raw.refundUntil.toISOString() },
    });
    await notifyEventChange(tx, extension.id);
    return extension;
  });
  notifyEventChangeInBackground(db, extension.id);
  return extension;
}

export type EventChangeView = Awaited<ReturnType<typeof listEventChanges>>[number];

/**
 * Histórico do evento (mais recente primeiro) com o prazo vigente de cada alteração e,
 * nas alterações originais, quantos compradores pediram reembolso pela janela dela
 * (`Refund.eventChangeId`, gravado pelo `pagamentos-financeiro`; só contagens).
 */
export async function listEventChanges(db: Db, actor: Actor, eventId: string, now = new Date()) {
  await assertEventPermission(db, actor, eventId, "org:read");
  const [rows, refundRows] = await Promise.all([
    db.eventChange.findMany({
      where: { eventId },
      orderBy: { createdAt: "desc" },
      include: { actor: { select: { name: true } } },
    }),
    db.$queryRaw<{ eventChangeId: string; requested: number; refunded: number }[]>`
      SELECT r."eventChangeId" AS "eventChangeId",
             count(DISTINCT o."userId")::int AS requested,
             count(DISTINCT o."userId") FILTER (WHERE r.status = 'SUCCEEDED')::int AS refunded
        FROM "Refund" r JOIN "Order" o ON o.id = r."orderId"
       WHERE o."eventId" = ${eventId} AND r."eventChangeId" IS NOT NULL
       GROUP BY r."eventChangeId"`,
  ]);
  const refunds = new Map(refundRows.map((r) => [r.eventChangeId, r]));
  return rows.map((r) => {
    const rootId = r.extendsChangeId ?? r.id;
    const family = rows.filter((x) => x.id === rootId || x.extendsChangeId === rootId);
    const effective = family.reduce<Date | null>((m, x) => (x.refundUntil && (!m || x.refundUntil > m) ? x.refundUntil : m), null);
    return {
      id: r.id,
      createdAt: r.createdAt,
      actorName: r.actor?.name ?? "Sistema",
      changedFields: r.changedFields,
      before: r.before as Prisma.JsonObject,
      after: r.after as Prisma.JsonObject,
      reason: r.reason,
      refundUntil: r.refundUntil,
      extendsChangeId: r.extendsChangeId,
      effectiveRefundUntil: effective,
      windowOpen: !r.extendsChangeId && !!effective && effective > now,
      refundRequests: r.extendsChangeId ? null : { buyers: refunds.get(r.id)?.requested ?? 0, refunded: refunds.get(r.id)?.refunded ?? 0 },
    };
  });
}
