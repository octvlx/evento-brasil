import "server-only";
import type { CheckinResult } from "@/generated/prisma/client";
import type { Db } from "../db";
import { resolveCheckinAccess, type Actor } from "../auth/permissions";
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
  const [admitted, total] = await Promise.all([
    db.issuedTicket.count({ where: { eventId, status: "CHECKED_IN" } }),
    db.issuedTicket.count({ where: { eventId, status: { in: ["VALID", "CHECKED_IN"] } } }),
  ]);
  return { admitted, total };
}

/** Validação 100% online e atômica: só uma leitura pode transicionar VALID → CHECKED_IN. */
export async function checkInTicket(db: Db, actor: Actor, eventId: string, rawPayload: string, now = new Date()): Promise<CheckinResponse> {
  await resolveCheckinAccess(db, actor, eventId);
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { status: true, endsAt: true } });

  const record = async (result: CheckinResult, ticketId: string | null) => {
    await db.ticketCheckin.create({ data: { eventId, ticketId, scannedById: actor.id, result, scannedAt: now } });
  };
  const respond = async (result: CheckinResult, ticket?: CheckinResponse["ticket"]): Promise<CheckinResponse> => ({
    result,
    message: MESSAGES[result],
    ticket,
    counters: await counters(db, eventId),
  });

  const lateWindowOk = event.status === "COMPLETED" && now.getTime() - event.endsAt.getTime() < 12 * 3_600_000;
  if (event.status !== "PUBLISHED" && !lateWindowOk) {
    await record("EVENT_NOT_ACTIVE", null);
    return respond("EVENT_NOT_ACTIVE");
  }

  const parsed = parseQrPayload(rawPayload);
  const ticket = parsed
    ? await db.issuedTicket.findUnique({ where: { validationToken: parsed.token }, include: { ticketType: { select: { name: true } } } })
    : null;
  if (!parsed || !ticket || ticket.code !== parsed.code) {
    await record("INVALID", null);
    return respond("INVALID");
  }
  const view = (checkedInAt: Date | null) => ({ code: ticket.code, holderName: ticket.holderName, ticketTypeName: ticket.ticketType.name, checkedInAt });

  if (ticket.eventId !== eventId) {
    await record("WRONG_EVENT", ticket.id);
    return respond("WRONG_EVENT", view(null));
  }
  if (ticket.status === "REVOKED") {
    await record("REVOKED", ticket.id);
    return respond("REVOKED", view(null));
  }

  const { count } = await db.issuedTicket.updateMany({ where: { id: ticket.id, status: "VALID" }, data: { status: "CHECKED_IN", checkedInAt: now } });
  if (count === 1) {
    await record("ADMITTED", ticket.id);
    return respond("ADMITTED", view(now));
  }
  const current = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
  const result: CheckinResult = current.status === "REVOKED" ? "REVOKED" : "DUPLICATE";
  await record(result, ticket.id);
  return respond(result, view(current.checkedInAt));
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
