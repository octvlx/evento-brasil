import "server-only";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "../db";
import { audit } from "../audit";
import { REDACTED_NAME, RETENTION, redactedEmail } from "../retention";

// Expurgo programado (L9b): roda no cron de manutenção, em lotes, e é idempotente
// (cada passo só pega o que ainda não foi tratado). Prazos PROVISÓRIOS em
// src/server/retention.ts até a decisão D6. Não toca no que é prova e só de inserção:
// razão, repasses, auditoria, aceites de termos e histórico de transferências.

const BATCH = 200;
const DAY = 86_400_000;
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY);

export interface RetentionPurgeResult {
  sessions: number;
  expiredTokens: number;
  checkoutDrafts: number;
  invitations: number;
  chargeData: number;
  webhookPayloads: number;
  emailOutbox: number;
  checkins: number;
  orders: number;
  tickets: number;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

/** O cron de manutenção roda a cada minuto; o expurgo, no máximo uma vez por intervalo. */
export const PURGE_INTERVAL_MS = 3_600_000;
const RUN_ENTITY = { entityType: "RetentionPurge", entityId: "scheduled" } as const;

/**
 * Roda o expurgo se a última execução registrada tiver mais de PURGE_INTERVAL_MS.
 * Cada execução vai para a auditoria (só contagens), o que prova que o expurgo roda.
 * Duas chamadas simultâneas podem rodar ambas: o expurgo é idempotente.
 */
export async function runRetentionPurgeIfDue(db: Db, now = new Date()): Promise<RetentionPurgeResult | null> {
  const last = await db.auditLog.findFirst({ where: RUN_ENTITY, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  if (last && now.getTime() - last.createdAt.getTime() < PURGE_INTERVAL_MS) return null;
  const result = await runRetentionPurge(db, now);
  await audit(db, { action: "retention.purged", ...RUN_ENTITY, metadata: { ...result } });
  return result;
}

export async function runRetentionPurge(db: Db, now = new Date()): Promise<RetentionPurgeResult> {
  const tokenCutoff = daysAgo(now, RETENTION.expiredTokenDays);

  const sessions = await db.session.deleteMany({ where: { expiresAt: { lt: now } } });
  const [resets, verifications] = await Promise.all([
    db.passwordResetToken.deleteMany({ where: { expiresAt: { lt: tokenCutoff } } }),
    db.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: tokenCutoff } } }),
  ]);
  const checkoutDrafts = await db.checkoutDraft.deleteMany({ where: { orderId: null, expiresAt: { lt: tokenCutoff } } });

  const invitationCutoff = daysAgo(now, RETENTION.invitationDays);
  const invitations = await db.organizationInvitation.deleteMany({
    where: { OR: [{ acceptedAt: { lt: invitationCutoff } }, { revokedAt: { lt: invitationCutoff } }, { acceptedAt: null, expiresAt: { lt: invitationCutoff } }] },
  });

  // Dados da cobrança (QR/copia e cola do PIX, link do checkout) só servem enquanto pendente.
  const settled = await db.payment.findMany({
    where: {
      status: { not: "PENDING" },
      updatedAt: { lt: new Date(now.getTime() - RETENTION.chargeDataHoursAfterSettled * 3_600_000) },
      OR: [{ pixCopyPaste: { not: null } }, { pixQrCodeBase64: { not: null } }, { checkoutUrl: { not: null } }],
    },
    select: { id: true },
    take: BATCH,
  });
  const chargeData = await db.payment.updateMany({
    where: { id: { in: ids(settled) } },
    data: { pixCopyPaste: null, pixQrCodeBase64: null, checkoutUrl: null },
  });

  // Corpo do webhook: o id externo fica (idempotência), o conteúdo vira {}.
  const oldWebhooks = await db.paymentWebhookEvent.findMany({
    where: { receivedAt: { lt: daysAgo(now, RETENTION.webhookPayloadDays) }, NOT: { payload: { equals: {} } } },
    select: { id: true },
    take: BATCH,
  });
  const webhookPayloads = await db.paymentWebhookEvent.updateMany({ where: { id: { in: ids(oldWebhooks) } }, data: { payload: {} } });

  const emailOutbox = await db.emailOutbox.deleteMany({
    where: { createdAt: { lt: daysAgo(now, RETENTION.emailOutboxDays) }, status: { in: ["SENT", "FAILED", "CANCELLED", "UNKNOWN"] } },
  });

  const oldCheckins = await db.ticketCheckin.findMany({
    where: { event: { endsAt: { lt: daysAgo(now, RETENTION.checkinDaysAfterEvent) } } },
    select: { id: true },
    take: BATCH,
  });
  const checkins = await db.ticketCheckin.deleteMany({ where: { id: { in: ids(oldCheckins) } } });

  // Comprador e titular de eventos encerrados há mais que o prazo: valores, datas e
  // status ficam; nome, e-mail, celular e participantes saem. Pedidos ainda em aberto
  // (reembolso, contestação) esperam a conclusão.
  const piiCutoff = new Date(now);
  piiCutoff.setFullYear(piiCutoff.getFullYear() - RETENTION.orderPiiYearsAfterEvent);
  const oldOrders = await db.order.findMany({
    where: { piiRedactedAt: null, event: { endsAt: { lt: piiCutoff } }, status: { notIn: ["PENDING_PAYMENT", "REFUND_PENDING", "DISPUTED"] } },
    select: { id: true, userId: true },
    take: BATCH,
  });
  let orders = 0;
  for (const o of oldOrders) {
    await db.$transaction([
      db.order.update({ where: { id: o.id }, data: { buyerName: REDACTED_NAME, buyerEmail: redactedEmail(o.userId), buyerPhone: null, piiRedactedAt: now } }),
      db.orderItem.updateMany({ where: { orderId: o.id }, data: { attendees: Prisma.DbNull } }),
    ]);
    orders++;
  }
  const oldTickets = await db.issuedTicket.findMany({
    where: { piiRedactedAt: null, event: { endsAt: { lt: piiCutoff } } },
    select: { id: true, holderUserId: true },
    take: BATCH,
  });
  for (const t of oldTickets) {
    await db.issuedTicket.update({ where: { id: t.id }, data: { holderName: REDACTED_NAME, holderEmail: redactedEmail(t.holderUserId), piiRedactedAt: now } });
  }

  return {
    sessions: sessions.count,
    expiredTokens: resets.count + verifications.count,
    checkoutDrafts: checkoutDrafts.count,
    invitations: invitations.count,
    chargeData: chargeData.count,
    webhookPayloads: webhookPayloads.count,
    emailOutbox: emailOutbox.count,
    checkins: checkins.count,
    orders,
    tickets: oldTickets.length,
  };
}
