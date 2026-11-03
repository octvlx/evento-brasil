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

export function checkinWindowOpen(event: { status: EventStatus; endsAt: Date }, now = new Date()): boolean {
  return (event.status === "PUBLISHED" || event.status === "COMPLETED") && now.getTime() - event.endsAt.getTime() < CHECKIN_GRACE_MS;
}
