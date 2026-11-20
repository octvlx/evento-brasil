// Encerramento do evento pelo relógio, sem depender do job: `endsAt` é um instante
// UTC (gravado a partir do horário local e do fuso do evento), então a comparação
// com o relógio do servidor já considera o fuso. O job só grava COMPLETED depois.
import type { EventStatus } from "@/generated/prisma/enums";

/** Encerrado assim que o término chega (endsAt <= agora). */
export function hasEventEnded(event: { endsAt: Date }, now = new Date()): boolean {
  return event.endsAt.getTime() <= now.getTime();
}

/** Status que vale agora: PUBLISHED com término passado já é COMPLETED, mesmo antes do job. */
export function effectiveEventStatus(event: { status: EventStatus; endsAt: Date }, now = new Date()): EventStatus {
  return event.status === "PUBLISHED" && hasEventEnded(event, now) ? "COMPLETED" : event.status;
}

/**
 * Fechamento operacional da portaria: o check-in continua até 12 h depois do término
 * (atrasos, saídas e reentradas), separado do encerramento comercial (vendas).
 */
export const CHECKIN_GRACE_MS = 12 * 3_600_000;

/** Abertura padrão da portaria: 6 h antes do início. Cada evento pode mudar (0 a 7 dias). */
export const DEFAULT_CHECKIN_OPENS_MINUTES = 360;
export const MAX_CHECKIN_OPENS_MINUTES = 7 * 24 * 60;

export type CheckinWindowEvent = { status: EventStatus; startsAt: Date; endsAt: Date; checkinOpensMinutesBefore: number };

/** Quando a portaria passa a aceitar leituras. */
export function checkinOpensAt(event: Pick<CheckinWindowEvent, "startsAt" | "checkinOpensMinutesBefore">): Date {
  return new Date(event.startsAt.getTime() - event.checkinOpensMinutesBefore * 60_000);
}

const checkinStatus = (status: EventStatus) => status === "PUBLISHED" || status === "COMPLETED";

/** Portaria aberta: de `checkinOpensAt` até 12 h depois do término. */
export function checkinWindowOpen(event: CheckinWindowEvent, now = new Date()): boolean {
  return checkinStatus(event.status) && now >= checkinOpensAt(event) && now.getTime() - event.endsAt.getTime() < CHECKIN_GRACE_MS;
}

/** Evento ativo, mas a portaria ainda não abriu. */
export function checkinNotYetOpen(event: CheckinWindowEvent, now = new Date()): boolean {
  return checkinStatus(event.status) && now < checkinOpensAt(event);
}
