import "server-only";
import type { CheckinResult, EventStatus, TicketKind } from "@/generated/prisma/client";
import { checkinWindowOpen } from "@/lib/event-lifecycle";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { resolveCheckinAccess, type Actor } from "../auth/permissions";
import { hashToken } from "../crypto";
import { notFound } from "../errors";
import { parseQrPayload } from "./tickets";

export interface CheckinResponse {
  result: CheckinResult;
  message: string;
  // ticketKind permite à portaria exigir o documento da meia-entrada (HALF_PRICE).
  // Ausente, como o resto de `ticket`, em leituras de ingresso de outra organização.
  // transferred: o ingresso mudou de titular por transferência aceita (R6); holderName é
  // o titular atual. qrReplaced: o QR lido é o anterior a uma transferência (resultado
  // INVALID) — só informado para a mesma organização do evento.
  ticket?: { code: string; holderName: string | null; ticketTypeName: string; ticketKind: TicketKind; checkedInAt: Date | null; transferred: boolean; qrReplaced?: true };
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

const ticketForView = { ticketType: { select: { name: true, kind: true } }, event: { select: { organizationId: true } } } as const;

async function wasTransferred(tx: Tx, ticketId: string) {
  return !!(await tx.ticketTransfer.findFirst({ where: { ticketId, status: "ACCEPTED" }, select: { id: true } }));
}

/**
 * QR anterior a uma transferência aceita deste evento (o aceite troca o validationToken e
 * guarda o hash do antigo). Só para a portaria da organização do evento: devolve o
 * ingresso com o titular atual; de outra organização, nada.
 */
async function replacedByTransfer(tx: Tx, eventId: string, organizationId: string, parsed: { code: string; token: string }) {
  const transfer = await tx.ticketTransfer.findFirst({
    where: { eventId, status: "ACCEPTED", previousTokenHash: hashToken(parsed.token) },
    select: { ticket: { include: ticketForView } },
  });
  const t = transfer?.ticket;
  if (!t || t.code !== parsed.code || t.event.organizationId !== organizationId) return null;
  return t;
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
      // Pelo relógio: encerrado comercialmente (com ou sem o job) ainda aceita entrada
      // por 12 h; depois disso, fecha mesmo que o status no banco siga PUBLISHED.
      if (!checkinWindowOpen(event, now)) {
        await record("EVENT_NOT_ACTIVE", null);
        return { result: "EVENT_NOT_ACTIVE" };
      }

      // 2. QR → ingresso (busca pelo token; o código precisa bater).
      const parsed = parseQrPayload(rawPayload);
      const ticket = parsed
        ? await tx.issuedTicket.findUnique({ where: { validationToken: parsed.token }, include: ticketForView })
        : null;
      if (!parsed || !ticket || ticket.code !== parsed.code) {
        // QR antigo de ingresso transferido: continua INVALID, mas a portaria do
        // organizador vê que foi substituído e quem é o titular atual.
        const replaced = parsed && !ticket ? await replacedByTransfer(tx, eventId, event.organizationId, parsed) : null;
        await record("INVALID", replaced?.id ?? null);
        if (!replaced) return { result: "INVALID" };
        return {
          result: "INVALID",
          ticket: { code: replaced.code, holderName: replaced.holderName, ticketTypeName: replaced.ticketType.name, ticketKind: replaced.ticketType.kind, checkedInAt: replaced.checkedInAt, transferred: true, qrReplaced: true },
        };
      }
      // Só consultado quando o ingresso vai aparecer na tela (mesma organização).
      const transferred = ticket.event.organizationId === event.organizationId ? await wasTransferred(tx, ticket.id) : false;
      const view = (checkedInAt: Date | null) => ({ code: ticket.code, holderName: ticket.holderName, ticketTypeName: ticket.ticketType.name, ticketKind: ticket.ticketType.kind, checkedInAt, transferred });

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
      // O token entra no WHERE: se uma transferência aceita trocou o QR depois da busca
      // acima, o QR antigo não admite (defesa extra; o aceite já espera a trava do evento).
      const { count } = await tx.issuedTicket.updateMany({ where: { id: ticket.id, status: "VALID", validationToken: parsed.token }, data: { status: "CHECKED_IN", checkedInAt: now } });
      if (count === 1) {
        await record("ADMITTED", ticket.id);
        return { result: "ADMITTED", ticket: view(now) };
      }
      const current = await tx.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      if (current.validationToken !== parsed.token) {
        await record("INVALID", null);
        return { result: "INVALID" };
      }
      const result: CheckinResult = current.status === "REVOKED" ? "REVOKED" : "DUPLICATE";
      await record(result, ticket.id);
      return { result, ticket: view(current.checkedInAt) };
    },
    { ...TX_OPTIONS, isolationLevel: "ReadCommitted" },
  );

  // Contadores fora da transação, após o commit.
  const message = outcome.ticket?.qrReplaced ? "QR SUBSTITUÍDO — ingresso transferido" : MESSAGES[outcome.result];
  return { result: outcome.result, message, ticket: outcome.ticket, counters: await counters(db, eventId) };
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
