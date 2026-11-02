import "server-only";
import { enqueueCancelledEventEmailsTx } from "../email/events";
import { TX_OPTIONS, type Db } from "../db";
import { audit } from "../audit";
import { assertEventPermission, assertPlatformAdmin, type Actor } from "../auth/permissions";
import { AppError } from "../errors";
import { VALID_PAID_PAYMENTS, type PaymentProviderAdapter } from "../payments/types";
import { assertEventTransition } from "./events";
import { lockCouponsOfOrders, lockEvent, releaseOrderTx } from "./orders";
import { closePendingTransfersTx, processRefund } from "./refunds";

/**
 * Cancela o evento: libera reservas pendentes, revoga ingressos e abre um
 * reembolso integral por pedido pago (política padrão; revisão jurídica).
 */
export async function cancelEvent(
  db: Db,
  adapter: PaymentProviderAdapter,
  actor: Actor,
  eventId: string,
  reason: string,
  opts: { asAdmin?: boolean; autoRefund?: boolean } = {},
) {
  if (!reason.trim()) throw new AppError("VALIDATION", "Informe o motivo do cancelamento.");
  if (opts.asAdmin) assertPlatformAdmin(actor);
  else await assertEventPermission(db, actor, eventId, "event:cancel");

  const result = await db.$transaction(async (tx) => {
    await lockEvent(tx, eventId);
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
    assertEventTransition(event.status, "CANCELLED");
    const now = new Date();
    await tx.event.update({ where: { id: eventId }, data: { status: "CANCELLED", cancelledAt: now, cancellationReason: reason } });

    // Vários pedidos podem ter cupons distintos: trava todos de uma vez (ordem de id).
    await lockCouponsOfOrders(tx, { eventId, status: "PENDING_PAYMENT" });
    const pending = await tx.order.findMany({ where: { eventId, status: "PENDING_PAYMENT" }, select: { id: true } });
    for (const o of pending) await releaseOrderTx(tx, o.id, "CANCELLED", "event_cancelled", now);

    await tx.issuedTicket.updateMany({ where: { eventId, status: "VALID" }, data: { status: "REVOKED", revokedAt: now, revocationReason: "EVENT_CANCELLED" } });
    const transfersClosed = await closePendingTransfersTx(tx, { eventId }, "Evento cancelado", now);

    const paid = await tx.order.findMany({ where: { eventId, status: "PAID" }, include: { payments: VALID_PAID_PAYMENTS } });
    await enqueueCancelledEventEmailsTx(tx, eventId);
    const refundIds: string[] = [];
    for (const o of paid) {
      const key = `refund:${o.id}:event_cancelled`;
      const refund = await tx.refund.upsert({
        where: { idempotencyKey: key },
        create: { orderId: o.id, paymentId: o.payments[0]?.id ?? null, amountCents: o.totalCents, reason: "EVENT_CANCELLED", requestedById: actor.id, idempotencyKey: key },
        update: {},
      });
      await tx.order.update({ where: { id: o.id }, data: { status: "REFUND_PENDING" } });
      refundIds.push(refund.id);
    }
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: event.organizationId,
      action: "event.cancelled",
      entityType: "Event",
      entityId: eventId,
      metadata: { reason, pendingReleased: pending.length, refunds: refundIds.length, transfersClosed },
    });
    return { pendingReleased: pending.length, refundIds };
  }, TX_OPTIONS);

  if (opts.autoRefund ?? true) {
    for (const id of result.refundIds) await processRefund(db, adapter, id);
  }
  return result;
}
