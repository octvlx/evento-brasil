// Reembolsos integrais (MVP). Reembolso parcial não é suportado.
import "server-only";
import type { RefundReason } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { assertActive, assertPlatformAdmin, type Actor } from "../auth/permissions";
import { env } from "../env";
import { AppError, forbidden, invalidState, notFound } from "../errors";
import type { PaymentProviderAdapter } from "../payments/types";
import { postReversal } from "./ledger";
import { lockEvent, lockOrder } from "./orders";

export interface RefundPolicyConfig {
  windowDays: number;
  minHoursBeforeEvent: number;
}

export const refundPolicyFromEnv = (): RefundPolicyConfig => ({
  windowDays: env().REFUND_WINDOW_DAYS,
  minHoursBeforeEvent: env().REFUND_MIN_HOURS_BEFORE_EVENT,
});

/**
 * Elegibilidade para reembolso solicitado pelo comprador. Valores padrão
 * (7 dias da compra e 48h antes do evento) são configuráveis e PRECISAM de
 * revisão jurídica (CDC art. 49 e normas aplicáveis a eventos).
 */
export function refundEligibility(
  order: { status: string; paidAt: Date | null; totalCents: number },
  event: { startsAt: Date; status: string },
  tickets: { status: string }[],
  now: Date,
  cfg: RefundPolicyConfig,
): { eligible: true } | { eligible: false; reason: string } {
  if (order.status !== "PAID") return { eligible: false, reason: "Somente pedidos pagos podem ser reembolsados." };
  if (event.status === "CANCELLED") return { eligible: false, reason: "Evento cancelado: o reembolso é processado automaticamente." };
  if (tickets.some((t) => t.status === "CHECKED_IN")) return { eligible: false, reason: "Há ingressos já utilizados neste pedido." };
  if (!order.paidAt || now.getTime() - order.paidAt.getTime() > cfg.windowDays * 86_400_000)
    return { eligible: false, reason: `O prazo de ${cfg.windowDays} dias após a compra terminou.` };
  if (event.startsAt.getTime() - now.getTime() < cfg.minHoursBeforeEvent * 3_600_000)
    return { eligible: false, reason: `Reembolsos só até ${cfg.minHoursBeforeEvent}h antes do evento.` };
  return { eligible: true };
}

async function createRefundRequest(db: Db, orderId: string, reason: RefundReason, requestedById: string | null, note?: string) {
  return db.$transaction(async (tx) => {
    const ref = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { eventId: true } });
    await lockEvent(tx, ref.eventId);
    await lockOrder(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: { where: { status: "PAID" } } } });
    if (order.status !== "PAID") throw invalidState("Pedido não está pago.");
    const key = `refund:${orderId}:${reason.toLowerCase()}`;
    const refund = await tx.refund.upsert({
      where: { idempotencyKey: key },
      create: { orderId, paymentId: order.payments[0]?.id ?? null, amountCents: order.totalCents, reason, requestedById, note, idempotencyKey: key },
      update: {},
    });
    await tx.order.update({ where: { id: orderId }, data: { status: "REFUND_PENDING" } });
    await audit(tx, { actorUserId: requestedById, organizationId: order.organizationId, action: "refund.requested", entityType: "Refund", entityId: refund.id, metadata: { reason } });
    return refund;
  }, TX_OPTIONS);
}

export async function requestCustomerRefund(db: Db, adapter: PaymentProviderAdapter, actor: Actor, orderId: string, now = new Date()) {
  assertActive(actor);
  const order = await db.order.findUnique({ where: { id: orderId }, include: { event: true, tickets: { select: { status: true } } } });
  if (!order) throw notFound();
  if (order.userId !== actor.id) throw forbidden();
  const check = refundEligibility(order, order.event, order.tickets, now, refundPolicyFromEnv());
  if (!check.eligible) throw new AppError("VALIDATION", check.reason);
  const refund = await createRefundRequest(db, orderId, "CUSTOMER_REQUEST", actor.id);
  await processRefund(db, adapter, refund.id);
  return db.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

export async function adminRefundOrder(db: Db, adapter: PaymentProviderAdapter, admin: Actor, orderId: string, note: string) {
  assertPlatformAdmin(admin);
  if (!note.trim()) throw new AppError("VALIDATION", "Informe o motivo do reembolso.");
  const refund = await createRefundRequest(db, orderId, "ADMIN", admin.id, note);
  await processRefund(db, adapter, refund.id);
  return db.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** Solicita o estorno ao provedor. Confirma imediatamente se o provedor responder sucesso. */
export async function processRefund(db: Db, adapter: PaymentProviderAdapter, refundId: string) {
  const refund = await db.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund || !["REQUESTED", "FAILED"].includes(refund.status)) return refund;
  const claimed = await db.refund.updateMany({ where: { id: refundId, status: { in: ["REQUESTED", "FAILED"] } }, data: { status: "PROCESSING" } });
  if (!claimed.count) return refund;

  // Pedido gratuito ou sem pagamento no provedor: nada a estornar externamente.
  if (refund.amountCents === 0 || !refund.payment?.providerPaymentId || refund.payment.method === "FREE") {
    await db.$transaction((tx) => confirmRefundTxWithLocks(tx, refundId), TX_OPTIONS);
    return db.refund.findUnique({ where: { id: refundId } });
  }
  try {
    const result = await adapter.refundPayment({
      providerPaymentId: refund.payment.providerPaymentId,
      amountCents: refund.amountCents,
      idempotencyKey: refund.idempotencyKey,
    });
    await db.refund.update({ where: { id: refundId }, data: { providerRefundId: result.providerRefundId } });
    if (result.status === "SUCCEEDED") await db.$transaction((tx) => confirmRefundTxWithLocks(tx, refundId), TX_OPTIONS);
    else if (result.status === "FAILED") await db.refund.update({ where: { id: refundId }, data: { status: "FAILED", note: "Provedor recusou o estorno." } });
    // PENDING: aguarda webhook do provedor.
  } catch (err) {
    await db.refund.update({ where: { id: refundId }, data: { status: "FAILED", note: `Erro no provedor: ${String(err).slice(0, 300)}` } });
  }
  return db.refund.findUnique({ where: { id: refundId } });
}

async function confirmRefundTxWithLocks(tx: Tx, refundId: string) {
  const r = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: { order: { select: { id: true, eventId: true } } } });
  await lockEvent(tx, r.order.eventId);
  await lockOrder(tx, r.order.id);
  await confirmRefundTx(tx, refundId);
}

/**
 * Efetiva o reembolso: revoga ingressos, atualiza contadores e lança o estorno
 * no razão. Pré-condição: travas do evento e do pedido. Idempotente.
 */
export async function confirmRefundTx(tx: Tx, refundId: string, now = new Date()) {
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (refund.status === "SUCCEEDED") return false;
  const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId }, include: { commissionRule: true, tickets: true } });

  await tx.refund.update({ where: { id: refundId }, data: { status: "SUCCEEDED", processedAt: now } });
  const reason = refund.reason === "EVENT_CANCELLED" ? "EVENT_CANCELLED" : "REFUNDED";
  await tx.issuedTicket.updateMany({ where: { orderId: order.id, status: { in: ["VALID", "CHECKED_IN"] } }, data: { status: "REVOKED", revokedAt: now, revocationReason: reason } });
  const perType = new Map<string, number>();
  for (const t of order.tickets) perType.set(t.ticketTypeId, (perType.get(t.ticketTypeId) ?? 0) + 1);
  for (const [ticketTypeId, n] of perType) {
    await tx.ticketType.update({ where: { id: ticketTypeId }, data: { quantityRefunded: { increment: n } } });
  }
  if (refund.paymentId) await tx.payment.update({ where: { id: refund.paymentId }, data: { status: "REFUNDED" } });
  await tx.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
  await postReversal(tx, "REFUND", order, {
    refundId,
    paymentId: refund.paymentId ?? undefined,
    returnCommission: order.commissionRule?.refundCommissionOnRefund ?? true,
  });
  await audit(tx, { organizationId: order.organizationId, action: "refund.succeeded", entityType: "Refund", entityId: refundId, metadata: { reason: refund.reason } });
  return true;
}
