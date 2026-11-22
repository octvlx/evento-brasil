import "server-only";
import type { Db } from "../db";
import { env } from "../env";
import { enqueueEmail } from "../email/outbox";
import { transactionalEmail } from "../email/templates";
import { formatEventDateTime } from "@/lib/datetime";

// Aviso único do QR dinâmico (#175): quem recebeu ingresso antes da mudança foi orientado a
// apresentar o QR do PDF, que deixou de valer. Avisa o titular ATUAL de cada ingresso válido
// de evento que ainda vai acontecer (é quem precisa abrir o QR na tela), uma vez por pessoa
// e evento (dedupeKey), pela fila de e-mails.

/** Entrada em produção do QR dinâmico (merge do #175): ingressos emitidos antes disso. */
export const DYNAMIC_QR_LAUNCH = new Date("2026-11-22T04:00:32Z");

export interface QrNoticeTarget {
  eventId: string;
  eventTitle: string;
  startsAt: Date;
  timezone: string;
  recipients: { userId: string; email: string; name: string; tickets: number }[];
}

/** Titulares a avisar, por evento. Só leitura. */
export async function dynamicQrNoticeTargets(db: Db, now = new Date()): Promise<QrNoticeTarget[]> {
  const tickets = await db.issuedTicket.findMany({
    where: {
      status: "VALID",
      issuedAt: { lt: DYNAMIC_QR_LAUNCH },
      event: { status: "PUBLISHED", endsAt: { gt: now } },
      holder: { anonymizedAt: null, status: "ACTIVE" },
    },
    select: {
      eventId: true,
      event: { select: { title: true, startsAt: true, timezone: true } },
      holder: { select: { id: true, email: true, name: true } },
    },
  });
  const byEvent = new Map<string, QrNoticeTarget>();
  for (const t of tickets) {
    const target = byEvent.get(t.eventId) ?? { eventId: t.eventId, eventTitle: t.event.title, startsAt: t.event.startsAt, timezone: t.event.timezone, recipients: [] };
    byEvent.set(t.eventId, target);
    const r = target.recipients.find((x) => x.userId === t.holder.id);
    if (r) r.tickets++;
    else target.recipients.push({ userId: t.holder.id, email: t.holder.email, name: t.holder.name, tickets: 1 });
  }
  return [...byEvent.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

export const qrNoticeDedupeKey = (eventId: string, userId: string) => `qr-dinamico-aviso:${eventId}:${userId}`;

/** Põe os avisos na fila (o worker de e-mail envia). Repetir não duplica. */
export async function enqueueDynamicQrNotice(db: Db, now = new Date()) {
  const targets = await dynamicQrNoticeTargets(db, now);
  const url = `${new URL(env().APP_URL).origin}/meus-ingressos`;
  let queued = 0;
  for (const t of targets) {
    for (const r of t.recipients) {
      await enqueueEmail(db, {
        dedupeKey: qrNoticeDedupeKey(t.eventId, r.userId),
        template: "DYNAMIC_QR_NOTICE",
        recipient: r.email,
        // Depois do início do evento o aviso não serve mais.
        expiresAt: t.startsAt,
        message: transactionalEmail(
          "event",
          t.eventTitle,
          [
            `Mudou a forma de entrar em ${t.eventTitle} (${formatEventDateTime(t.startsAt, t.timezone)}).`,
            "O PDF do ingresso NÃO vale mais na entrada, nem print ou foto do QR.",
            "Na portaria, abra o ingresso no site ou app TICKET24, logado na sua conta, e mostre o QR da tela. Ele muda a cada 30 segundos.",
            r.tickets > 1 ? `Você tem ${r.tickets} ingressos neste evento: cada um tem o seu QR em Meus ingressos.` : "Seu ingresso está em Meus ingressos.",
            "Dica: chegue com o celular carregado e abra o ingresso antes de entrar na fila.",
          ],
          url,
        ),
      });
      queued++;
    }
  }
  return { events: targets.length, queued };
}
