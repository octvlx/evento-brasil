// Lembrete por e-mail antes do evento: cada titular de ingresso válido recebe um e-mail
// com data, horário, local e como entrar (QR dinâmico). Roda no cron de manutenção.
//
// Idempotente em duas camadas: o marcador Event.reminderQueuedFor (o início para o qual
// o lembrete já saiu; se o organizador muda a data, sai de novo) e a dedupeKey da fila,
// que inclui o início. O e-mail expira no início do evento: nunca chega depois.
import "server-only";
import type { Db } from "../db";
import { env } from "../env";
import { enqueueEmail } from "../email/outbox";
import { transactionalEmail } from "../email/templates";
import { formatDateLong, formatTime } from "@/lib/datetime";

const HOUR = 3_600_000;
/** O lembrete sai quando faltam até 24 h para o início. */
export const REMINDER_LEAD_HOURS = 24;
/** Evento começando em menos que isso não recebe lembrete: não daria tempo de ser útil. */
export const REMINDER_MIN_HOURS = 2;
/** Ingresso emitido há menos que isso fica sem lembrete: a pessoa acabou de receber o e-mail dos ingressos. */
export const REMINDER_FRESH_TICKET_HOURS = 2;
/** Eventos por passada do cron (o resto fica para o minuto seguinte). */
const EVENTS_PER_RUN = 10;

type ReminderEvent = {
  title: string;
  startsAt: Date;
  timezone: string;
  checkinOpensMinutesBefore: number;
  locationType: "VENUE" | "ONLINE";
  venue: { name: string; addressLine: string | null; district: string | null; isFictional: boolean } | null;
  city: { name: string; state: string } | null;
};

/** Texto do lembrete. Exportado para teste. */
export function reminderLines(e: ReminderEvent, ticketCount: number): string[] {
  const when = `${formatDateLong(e.startsAt, e.timezone)}, às ${formatTime(e.startsAt, e.timezone)} (horário do evento)`;
  const where =
    e.locationType === "ONLINE"
      ? "Evento online: o acesso fica na página do evento e nos seus ingressos."
      : "Local: " +
        [e.venue?.name, e.venue && !e.venue.isFictional ? e.venue.addressLine : null, e.venue && !e.venue.isFictional ? e.venue.district : null, e.city ? `${e.city.name} - ${e.city.state}` : null]
          .filter(Boolean)
          .join(", ") +
        ".";
  const opens = new Date(e.startsAt.getTime() - e.checkinOpensMinutesBefore * 60_000);
  return [
    `Quando: ${when}.`,
    where,
    ticketCount === 1 ? "Você tem 1 ingresso para este evento." : `Você tem ${ticketCount} ingressos para este evento.`,
    ...(e.locationType === "VENUE" && e.checkinOpensMinutesBefore <= 24 * 60
      ? [`A entrada abre às ${formatTime(opens, e.timezone)}.`]
      : []),
    "Na entrada, abra o ingresso no site ou na carteira do celular e mostre o QR Code. Ele muda sozinho a cada poucos segundos: print e PDF não valem na portaria.",
  ];
}

/**
 * Enfileira os lembretes dos eventos publicados que começam entre REMINDER_MIN_HOURS e
 * REMINDER_LEAD_HOURS a partir de agora. Um e-mail por titular (com a quantidade de
 * ingressos), só para ingressos válidos (não usados, revogados ou reembolsados).
 */
export async function enqueueEventReminders(db: Db, now = new Date()) {
  const candidates = await db.event.findMany({
    where: {
      status: "PUBLISHED",
      suspendedAt: null,
      startsAt: { gt: new Date(now.getTime() + REMINDER_MIN_HOURS * HOUR), lte: new Date(now.getTime() + REMINDER_LEAD_HOURS * HOUR) },
    },
    select: { id: true, startsAt: true, reminderQueuedFor: true },
    orderBy: { startsAt: "asc" },
  });
  // O Prisma não compara duas colunas: o filtro do marcador fica aqui (são poucos eventos).
  const due = candidates.filter((e) => e.reminderQueuedFor?.getTime() !== e.startsAt.getTime()).slice(0, EVENTS_PER_RUN);
  let events = 0,
    queued = 0;
  for (const { id } of due) {
    const n = await db.$transaction(
      async (tx) => {
        // Trava o evento: duas passadas simultâneas do cron não enfileiram em dobro.
        await tx.$queryRawUnsafe('SELECT id FROM "Event" WHERE id=$1 FOR UPDATE', id);
        const e = await tx.event.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            title: true,
            status: true,
            suspendedAt: true,
            startsAt: true,
            timezone: true,
            reminderQueuedFor: true,
            checkinOpensMinutesBefore: true,
            locationType: true,
            venue: { select: { name: true, addressLine: true, district: true, isFictional: true } },
            city: { select: { name: true, state: true } },
          },
        });
        if (e.status !== "PUBLISHED" || e.suspendedAt || e.reminderQueuedFor?.getTime() === e.startsAt.getTime()) return null;
        const tickets = await tx.issuedTicket.findMany({
          where: {
            eventId: id,
            status: "VALID",
            piiRedactedAt: null,
            issuedAt: { lte: new Date(now.getTime() - REMINDER_FRESH_TICKET_HOURS * HOUR) },
            order: { status: "PAID" },
          },
          select: { holder: { select: { email: true } } },
        });
        const perHolder = new Map<string, number>();
        for (const t of tickets) {
          const email = t.holder.email.toLowerCase();
          perHolder.set(email, (perHolder.get(email) ?? 0) + 1);
        }
        for (const [recipient, count] of perHolder)
          await enqueueEmail(tx, {
            dedupeKey: `reminder:${id}:${e.startsAt.toISOString()}:${recipient}`,
            template: "EVENT_REMINDER",
            recipient,
            message: transactionalEmail("reminder", e.title, reminderLines(e, count), env().APP_URL + "/meus-ingressos"),
            expiresAt: e.startsAt,
          });
        await tx.event.update({ where: { id }, data: { reminderQueuedFor: e.startsAt } });
        return perHolder.size;
      },
      { timeout: 120_000 },
    );
    if (n !== null) {
      events++;
      queued += n;
    }
  }
  return { events, queued };
}
