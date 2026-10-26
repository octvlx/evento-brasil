import "server-only";
import type { CheckinResult, EventStatus } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { resolveCheckinAccess, type Actor } from "../auth/permissions";
import { notFound } from "../errors";
import { parseQrPayload } from "./tickets";

export interface CheckinResponse {
  result: CheckinResult;
  message: string;
  ticket?: { code: string; holderName: string | null; ticketTypeName: string; checkedInAt: Date | null };
  counters: { admitted: number; total: number };
}

const MESSAGES: Record<CheckinResult, string> = {
  ADMITTED: "Entrada liberada",
  DUPLICATE: "Ingresso JÁ UTILIZADO",
  WRONG_EVENT: "Ingresso de OUTRO evento",
  REVOKED: "Ingresso CANCELADO/REEMBOLSADO",
  INVALID: "QR code inválido",
  EVENT_NOT_ACTIVE: "Evento não está ativo para check-in",
};

async function counters(db: Db, eventId: string) {
  const rows = await db.issuedTicket.groupBy({ by: ["status"], where: { eventId }, _count: { _all: true } });
  const of = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
  const admitted = of("CHECKED_IN");
  return { admitted, total: admitted + of("VALID") };
}

// Travas na MESMA ordem do restante do app (cancellation/refunds/payments/orders):
// Event → Order → ingressos. FOR KEY SHARE não bloqueia outras leituras de check-in
// (nem UPDATEs que não mexem na chave), mas espera quem segura FOR UPDATE — ou seja,
// cancelamento, reembolso e chargeback — e impede que eles comecem no meio da leitura.
async function lockEventForCheckin(tx: Tx, eventId: string) {
  const rows = await tx.$queryRaw<{ status: EventStatus; endsAt: Date; organizationId: string }[]>`SELECT status, "endsAt", "organizationId" FROM "Event" WHERE id = ${eventId} FOR KEY SHARE`;
  if (!rows[0]) throw notFound("Evento não encontrado.");
  return { status: rows[0].status, endsAt: new Date(rows[0].endsAt), organizationId: rows[0].organizationId };
}

async function lockOrderForCheckin(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT status FROM "Order" WHERE id = ${orderId} FOR KEY SHARE`;
}

/**
 * Validação 100% online e atômica: só uma leitura pode transicionar VALID → CHECKED_IN,
 * e a transição e o registro da leitura (TicketCheckin) são gravados na mesma transação.
 */
export async function checkInTicket(db: Db, actor: Actor, eventId: string, rawPayload: string, now = new Date()): Promise<CheckinResponse> {
  await resolveCheckinAccess(db, actor, eventId);

  const outcome = await db.$transaction(
    async (tx): Promise<{ result: CheckinResult; ticket?: CheckinResponse["ticket"] }> => {
      const record = (result: CheckinResult, ticketId: string | null) =>
        tx.ticketCheckin.create({ data: { eventId, ticketId, scannedById: actor.id, result, scannedAt: now } });

      // 1. Evento (trava compartilhada) e janela de check-in.
      const event = await lockEventForCheckin(tx, eventId);
      const lateWindowOk = event.status === "COMPLETED" && now.getTime() - event.endsAt.getTime() < 12 * 3_600_000;
      if (event.status !== "PUBLISHED" && !lateWindowOk) {
        await record("EVENT_NOT_ACTIVE", null);
        return { result: "EVENT_NOT_ACTIVE" };
      }

      // 2. QR → ingresso (busca pelo token; o código precisa bater).
      const parsed = parseQrPayload(rawPayload);
      const ticket = parsed
        ? await tx.issuedTicket.findUnique({ where: { validationToken: parsed.token }, include: { ticketType: { select: { name: true } }, event: { select: { organizationId: true } } } })
        : null;
      if (!parsed || !ticket || ticket.code !== parsed.code) {
        await record("INVALID", null);
        return { result: "INVALID" };
      }
      const view = (checkedInAt: Date | null) => ({ code: ticket.code, holderName: ticket.holderName, ticketTypeName: ticket.ticketType.name, checkedInAt });

      if (ticket.eventId !== eventId) {
        // Ingresso de outra organização: a leitura não é vinculada ao ingresso nem revela
        // o titular (o histórico desta organização não pode expor dados de compradores alheios).
        if (ticket.event.organizationId !== event.organizationId) {
          await record("WRONG_EVENT", null);
          return { result: "WRONG_EVENT" };
        }
        await record("WRONG_EVENT", ticket.id);
        return { result: "WRONG_EVENT", ticket: view(null) };
      }

      // 3. Pedido (trava compartilhada, mesma ordem de reembolso/chargeback).
      await lockOrderForCheckin(tx, ticket.orderId);

      // 4. Transição condicional VALID → CHECKED_IN.
      if (ticket.status === "REVOKED") {
        await record("REVOKED", ticket.id);
        return { result: "REVOKED", ticket: view(null) };
      }
      const { count } = await tx.issuedTicket.updateMany({ where: { id: ticket.id, status: "VALID" }, data: { status: "CHECKED_IN", checkedInAt: now } });
      if (count === 1) {
        await record("ADMITTED", ticket.id);
        return { result: "ADMITTED", ticket: view(now) };
      }
      const current = await tx.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      const result: CheckinResult = current.status === "REVOKED" ? "REVOKED" : "DUPLICATE";
      await record(result, ticket.id);
      return { result, ticket: view(current.checkedInAt) };
    },
    { ...TX_OPTIONS, isolationLevel: "ReadCommitted" },
  );

  // Contadores fora da transação, após o commit.
  return { result: outcome.result, message: MESSAGES[outcome.result], ticket: outcome.ticket, counters: await counters(db, eventId) };
}

export async function checkinHistory(db: Db, actor: Actor, eventId: string, limit = 50) {
  const { canSeeAllHistory } = await resolveCheckinAccess(db, actor, eventId);
  return db.ticketCheckin.findMany({
    where: { eventId, ...(canSeeAllHistory ? {} : { scannedById: actor.id }) },
    include: { ticket: { select: { code: true, holderName: true } }, scannedBy: { select: { name: true } } },
    orderBy: { scannedAt: "desc" },
    take: limit,
  });
}
