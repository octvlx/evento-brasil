// Reembolsos integrais (MVP). Reembolso parcial não é suportado.
import "server-only";
import type { RefundReason, RefundStatus } from "@/generated/prisma/client";
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

/**
 * Soma dos reembolsos do pedido que já comprometem o valor pago (exceto `excludeId`).
 * Invariante: reembolsos bem-sucedidos/em curso ≤ valor pago do pedido.
 */
async function committedRefundCents(client: Db | Tx, orderId: string, statuses: RefundStatus[], excludeId?: string) {
  const agg = await client.refund.aggregate({
    where: { orderId, status: { in: statuses }, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

export class OverRefundError extends Error {}

async function createRefundRequest(db: Db, orderId: string, reason: RefundReason, requestedById: string | null, note?: string) {
  return db.$transaction(async (tx) => {
    const ref = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { eventId: true } });
    await lockEvent(tx, ref.eventId);
    await lockOrder(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: { where: { status: "PAID" } } } });
    if (order.status !== "PAID") throw invalidState("Pedido não está pago.");
    // Reembolsos são integrais (MVP): qualquer outro em aberto ou concluído impede um novo.
    if ((await committedRefundCents(tx, orderId, ["REQUESTED", "PROCESSING", "SUCCEEDED"])) > 0) {
      throw invalidState("Este pedido já tem um reembolso em andamento.");
    }
    // Revoga os ingressos AGORA, sob as travas: um check-in concorrente
    // (UPDATE … WHERE status='VALID') não consegue mais usar o ingresso, e um
    // check-in que chegou antes é detectado abaixo. Antes, a verificação era
    // feita fora da trava e o comprador podia entrar E ser reembolsado.
    const now = new Date();
    await tx.issuedTicket.updateMany({ where: { orderId, status: "VALID" }, data: { status: "REVOKED", revokedAt: now, revocationReason: "REFUNDED" } });
    if (reason === "CUSTOMER_REQUEST") {
      const used = await tx.issuedTicket.count({ where: { orderId, status: "CHECKED_IN" } });
      if (used > 0) throw new AppError("VALIDATION", "Há ingressos já utilizados neste pedido.");
    }
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

  // Guarda contra estorno acima do valor pago, ANTES de chamar o provedor.
  const order = await db.order.findUniqueOrThrow({ where: { id: refund.orderId }, select: { totalCents: true } });
  const others = await committedRefundCents(db, refund.orderId, ["PROCESSING", "SUCCEEDED"], refundId);
  if (others + refund.amountCents > order.totalCents) {
    await db.refund.update({ where: { id: refundId }, data: { status: "FAILED", note: "OVER_REFUND_BLOCKED: soma de reembolsos excederia o valor pago." } });
    return db.refund.findUnique({ where: { id: refundId } });
  }

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

/**
 * Retoma um reembolso parado em PROCESSING (ex.: o processo caiu entre "reivindicar"
 * e chamar o provedor). Reenvia ao provedor com a MESMA chave de idempotência, então
 * nunca estorna duas vezes. Usado pela reconciliação.
 */
export async function resumeRefund(db: Db, adapter: PaymentProviderAdapter, refundId: string) {
  const refund = await db.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund) return null;
  if (refund.status === "REQUESTED") return (await processRefund(db, adapter, refundId))?.status ?? null;
  if (refund.status !== "PROCESSING") return refund.status;
  if (refund.amountCents === 0 || !refund.payment?.providerPaymentId || refund.payment.method === "FREE") {
    await db.$transaction((tx) => confirmRefundTxWithLocks(tx, refundId), TX_OPTIONS);
    return "SUCCEEDED";
  }
  const result = await adapter.refundPayment({
    providerPaymentId: refund.payment.providerPaymentId,
    amountCents: refund.amountCents,
    idempotencyKey: refund.idempotencyKey,
  });
  await db.refund.update({ where: { id: refundId }, data: { providerRefundId: result.providerRefundId } });
  if (result.status === "SUCCEEDED") await db.$transaction((tx) => confirmRefundTxWithLocks(tx, refundId), TX_OPTIONS);
  else if (result.status === "FAILED") await db.refund.update({ where: { id: refundId }, data: { status: "FAILED", note: "Provedor recusou o estorno (reconciliação)." } });
  return result.status;
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
  // Última linha de defesa: nunca registrar estorno acima do valor pago.
  if ((await committedRefundCents(tx, order.id, ["SUCCEEDED"], refundId)) + refund.amountCents > order.totalCents) {
    throw new OverRefundError(`Reembolso ${refundId} excederia o valor pago do pedido ${order.publicCode}.`);
  }

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
