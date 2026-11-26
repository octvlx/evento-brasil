// Mapa de assentos (lugar marcado) por tipo de ingresso, em grade: fileiras (A, B, C…)
// com N assentos numerados. O estoque do tipo continua nos contadores de TicketType
// (quantityTotal = assentos não bloqueados); o assento é a restrição a mais: cada
// unidade reservada ou vendida ocupa um assento (Seat.orderItemId + sequence), sempre
// sob a trava do evento, como a reserva de estoque. Ver createOrder/releaseOrderTx.
import "server-only";
import { z } from "zod";
import type { Db } from "../db";
import { audit } from "../audit";
import { assertEventPermission, type Actor } from "../auth/permissions";
import { AppError, invalidState, notFound } from "../errors";
import { effectiveEventStatus } from "@/lib/event-lifecycle";
import { computeHalfPriceState } from "@/features/half-price/quota";
import { halfPriceSnapshot, loadHalfPriceStateTx } from "./half-price";
import { EDITABLE, assertNotSuspended, guardStockChange } from "./events";
import { reachableEventWhere } from "./catalog";

export const MAX_SEATS_PER_TYPE = 5000;
export const MAX_SEATS_PER_ROW = 200;

export const seatGridSchema = z.object({
  rows: z
    .array(
      z.object({
        row: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9]{1,3}$/, "Fileira: até 3 letras ou números (ex.: A, B, AA)."),
        seats: z.number().int().min(1).max(MAX_SEATS_PER_ROW),
      }),
    )
    .min(1, "Inclua ao menos uma fileira.")
    .max(200),
  /** Rótulos dos assentos bloqueados (ex.: "A1"): sem venda (corredor, câmera, cortesia). */
  blocked: z.array(z.string().trim().toUpperCase().max(8)).max(MAX_SEATS_PER_TYPE).default([]),
});
export type SeatGridInput = z.input<typeof seatGridSchema>;

export const seatLabel = (row: string, number: number) => `${row}${number}`;

type Desired = { row: string; number: number; label: string; blocked: boolean };

/** Grade validada → lista de assentos. Fileira repetida, total alto demais ou bloqueio inexistente são recusados. */
export function expandSeatGrid(raw: SeatGridInput): Desired[] {
  const parsed = seatGridSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Grade de assentos inválida.");
  const { rows, blocked } = parsed.data;
  const names = new Set<string>();
  for (const r of rows) {
    if (names.has(r.row)) throw new AppError("VALIDATION", `Fileira ${r.row} repetida.`);
    names.add(r.row);
  }
  const total = rows.reduce((s, r) => s + r.seats, 0);
  if (total > MAX_SEATS_PER_TYPE) throw new AppError("VALIDATION", `No máximo ${MAX_SEATS_PER_TYPE} assentos por tipo de ingresso.`);
  const seats = rows.flatMap((r) => Array.from({ length: r.seats }, (_, i) => ({ row: r.row, number: i + 1, label: seatLabel(r.row, i + 1), blocked: false })));
  const byLabel = new Map(seats.map((s) => [s.label, s]));
  for (const label of new Set(blocked)) {
    const seat = byLabel.get(label);
    if (!seat) throw new AppError("VALIDATION", `Assento bloqueado ${label} não existe na grade.`);
    seat.blocked = true;
  }
  if (!seats.some((s) => !s.blocked)) throw new AppError("VALIDATION", "Deixe ao menos um assento à venda.");
  return seats;
}

/**
 * Define (ou redefine) a grade de assentos do tipo e liga o lugar marcado.
 * - Tipo sem pedidos: a grade é livre.
 * - Com pedidos: só se o tipo já era de lugar marcado; assentos ocupados (reservados ou
 *   vendidos) não podem sumir nem ser bloqueados.
 * O estoque (quantityTotal) passa a ser o número de assentos à venda, sem ficar abaixo de
 * vendidos + reservados e sem invadir a cota legal de meia-entrada (L7c).
 */
export async function setSeatGrid(db: Db, actor: Actor, ticketTypeId: string, raw: SeatGridInput) {
  const desired = expandSeatGrid(raw);
  const tt0 = await db.ticketType.findUnique({ where: { id: ticketTypeId }, select: { eventId: true } });
  if (!tt0) throw notFound("Tipo de ingresso não encontrado.");
  const { organizationId } = await assertEventPermission(db, actor, tt0.eventId, "event:write");
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${tt0.eventId} FOR UPDATE`;
      const event = await tx.event.findUniqueOrThrow({ where: { id: tt0.eventId } });
      if (!EDITABLE.includes(effectiveEventStatus(event))) throw invalidState("Este evento não pode mais ser editado.");
      assertNotSuspended(event);
      const tt = await tx.ticketType.findUniqueOrThrow({ where: { id: ticketTypeId } });
      const hasOrders = (await tx.orderItem.count({ where: { ticketTypeId } })) > 0;
      if (hasOrders && !tt.seated) throw new AppError("VALIDATION", "Este ingresso já tem pedidos sem lugar marcado; crie outro tipo de ingresso para vender assentos.");

      const existing = await tx.seat.findMany({ where: { ticketTypeId } });
      const want = new Map(desired.map((d) => [d.label, d]));
      const occupied = existing.filter((s) => s.orderItemId);
      for (const s of occupied) {
        const d = want.get(s.label);
        if (!d) throw new AppError("VALIDATION", `O assento ${s.label} já foi reservado ou vendido e não pode sair da grade.`);
        if (d.blocked) throw new AppError("VALIDATION", `O assento ${s.label} já foi reservado ou vendido e não pode ser bloqueado.`);
      }
      const forSale = desired.filter((d) => !d.blocked).length;
      if (forSale < tt.quantitySold + tt.quantityReserved)
        throw new AppError("VALIDATION", `Assentos à venda insuficientes: há ${tt.quantitySold + tt.quantityReserved} vendidos ou reservados.`);

      // Meia-entrada (L7c): o novo estoque não pode invadir a cota legal.
      const now = new Date();
      const half = await loadHalfPriceStateTx(tx, tt.eventId, now);
      const afterTypes = half.types.map((t) => (t.id === tt.id ? { ...t, quantityTotal: forSale } : t));
      const before = guardStockChange(half, afterTypes, half.input.capacity, now);

      const have = new Map(existing.map((s) => [s.label, s]));
      const remove = existing.filter((s) => !want.has(s.label)).map((s) => s.id);
      if (remove.length) await tx.seat.deleteMany({ where: { id: { in: remove }, orderItemId: null } });
      const create = desired.filter((d) => !have.has(d.label));
      if (create.length)
        await tx.seat.createMany({ data: create.map((d) => ({ eventId: tt.eventId, ticketTypeId, row: d.row, number: d.number, label: d.label, blocked: d.blocked })) });
      const toBlock = desired.filter((d) => d.blocked && have.has(d.label) && !have.get(d.label)!.blocked).map((d) => d.label);
      const toFree = desired.filter((d) => !d.blocked && have.get(d.label)?.blocked).map((d) => d.label);
      if (toBlock.length) await tx.seat.updateMany({ where: { ticketTypeId, label: { in: toBlock }, orderItemId: null }, data: { blocked: true } });
      if (toFree.length) await tx.seat.updateMany({ where: { ticketTypeId, label: { in: toFree } }, data: { blocked: false } });

      const updated = await tx.ticketType.update({ where: { id: ticketTypeId }, data: { seated: true, quantityTotal: forSale } });
      if (tt.quantityTotal !== forSale) {
        await audit(tx, {
          actorUserId: actor.id,
          organizationId,
          action: "half_price.stock_changed",
          entityType: "TicketType",
          entityId: ticketTypeId,
          metadata: { source: "seat_map.updated", eventId: tt.eventId, before: halfPriceSnapshot(before), after: halfPriceSnapshot(computeHalfPriceState(half.input, afterTypes, now)) },
        });
      }
      await audit(tx, {
        actorUserId: actor.id,
        organizationId,
        action: "seat_map.updated",
        entityType: "TicketType",
        entityId: ticketTypeId,
        metadata: { rows: new Set(desired.map((d) => d.row)).size, seats: desired.length, blocked: desired.length - forSale },
      });
      return updated;
    },
    { timeout: 60_000 },
  );
}

/** Desliga o lugar marcado (apaga a grade). Só antes de qualquer pedido do tipo. */
export async function disableSeating(db: Db, actor: Actor, ticketTypeId: string) {
  const tt0 = await db.ticketType.findUnique({ where: { id: ticketTypeId }, select: { eventId: true } });
  if (!tt0) throw notFound("Tipo de ingresso não encontrado.");
  const { organizationId } = await assertEventPermission(db, actor, tt0.eventId, "event:write");
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${tt0.eventId} FOR UPDATE`;
    assertNotSuspended(await tx.event.findUniqueOrThrow({ where: { id: tt0.eventId }, select: { suspendedAt: true, suspensionReason: true } }));
    if ((await tx.orderItem.count({ where: { ticketTypeId } })) > 0) throw new AppError("VALIDATION", "Este ingresso já tem pedidos; o lugar marcado não pode ser desligado.");
    await tx.seat.deleteMany({ where: { ticketTypeId } });
    await tx.ticketType.update({ where: { id: ticketTypeId }, data: { seated: false } });
    await audit(tx, { actorUserId: actor.id, organizationId, action: "seat_map.disabled", entityType: "TicketType", entityId: ticketTypeId });
  });
}

export type SeatStatus = "FREE" | "TAKEN" | "BLOCKED";
export type SeatMapRow = { row: string; seats: { id: string; label: string; number: number; status: SeatStatus }[] };

/** Grade em fileiras, na ordem em que foram criadas (A, B… ou a ordem do organizador). */
function toRows(seats: { id: string; row: string; number: number; label: string; status: SeatStatus }[]): SeatMapRow[] {
  const rows = new Map<string, SeatMapRow>();
  for (const s of seats) {
    const r = rows.get(s.row) ?? { row: s.row, seats: [] };
    r.seats.push({ id: s.id, label: s.label, number: s.number, status: s.status });
    rows.set(s.row, r);
  }
  for (const r of rows.values()) r.seats.sort((a, b) => a.number - b.number);
  return [...rows.values()];
}

/**
 * Mapa público de um tipo de ingresso com lugar marcado: só livre, ocupado ou bloqueado
 * (nunca quem comprou). Reserva pendente já vencida conta como livre: o próximo pedido a
 * libera sob a trava do evento. Null se o evento não está à venda ou o tipo não é de lugar marcado.
 */
export async function publicSeatMap(db: Db, ticketTypeId: string, now = new Date()) {
  const tt = await db.ticketType.findFirst({
    where: { id: ticketTypeId, seated: true, isHidden: false, event: reachableEventWhere(now) },
    select: { id: true, name: true },
  });
  if (!tt) return null;
  const seats = await db.seat.findMany({
    where: { ticketTypeId },
    orderBy: [{ createdAt: "asc" }, { row: "asc" }, { number: "asc" }],
    select: { id: true, row: true, number: true, label: true, blocked: true, orderItem: { select: { order: { select: { status: true, expiresAt: true } } } } },
  });
  return {
    ticketTypeId: tt.id,
    name: tt.name,
    rows: toRows(
      seats.map((s) => {
        const o = s.orderItem?.order;
        const expiredHold = o?.status === "PENDING_PAYMENT" && o.expiresAt <= now;
        return { ...s, status: s.blocked ? "BLOCKED" : o && !expiredHold ? "TAKEN" : "FREE" };
      }),
    ),
  };
}

/** Grade atual para o editor do organizador (inclui quais assentos estão ocupados). */
export async function organizerSeatGrid(db: Db, actor: Actor, ticketTypeId: string) {
  const tt = await db.ticketType.findUnique({ where: { id: ticketTypeId }, select: { eventId: true, seated: true } });
  if (!tt) throw notFound("Tipo de ingresso não encontrado.");
  await assertEventPermission(db, actor, tt.eventId, "event:write");
  const seats = await db.seat.findMany({ where: { ticketTypeId }, orderBy: [{ createdAt: "asc" }, { row: "asc" }, { number: "asc" }] });
  return { seated: tt.seated, rows: toRows(seats.map((s) => ({ ...s, status: s.blocked ? "BLOCKED" : s.orderItemId ? "TAKEN" : "FREE" }))) };
}

export { claimSeatsTx, releaseSeatsTx, seatLabelsFor } from "./seat-holds";
