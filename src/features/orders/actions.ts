"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import type { CreateOrderInput } from "@/features/schemas";
import { db } from "@/server/db";
import { env, isProduction } from "@/server/env";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { getCurrentUser, requireUser } from "@/server/auth/current";
import { getPaymentAdapter, getSimulatedAdapter } from "@/server/payments";
import { cancelPendingOrder, createOrder } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment, syncPaymentFromProvider } from "@/server/services/payments";
import { requestCustomerRefund } from "@/server/services/refunds";
import type { SimulatedAction } from "@/server/payments/simulated";

export async function createOrderAction(input: CreateOrderInput): Promise<ActionResult<{ orderId: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Entre na sua conta para continuar.", code: "UNAUTHENTICATED" };
  return toActionResult(async () => {
    const order = await createOrder(db, user, input, { providerIsSimulated: getPaymentAdapter().isSimulated });
    return { orderId: order.id };
  });
}

export async function startPaymentAction(orderId: string, method: "PIX" | "CREDIT_CARD", simulatedCardOutcome?: "approve" | "decline") {
  const user = await requireUser(`/checkout/${orderId}`);
  const result = await toActionResult(() => startPayment(db, getPaymentAdapter(), user, orderId, method, { simulatedCardOutcome }));
  if (!result.ok) return result;
  refresh();
  return { ok: true as const, data: { paymentId: result.data.id, status: result.data.status } };
}

/** Ferramenta do simulador de pagamentos (somente ambiente de desenvolvimento). */
export async function simulatePaymentAction(orderId: string, action: SimulatedAction): Promise<ActionResult<{ result: string }>> {
  const user = await requireUser(`/checkout/${orderId}`);
  return toActionResult(async () => {
    const sim = getSimulatedAdapter();
    if (!sim || (isProduction() && !env().ALLOW_SIMULATED_PAYMENTS_IN_PRODUCTION)) throw new AppError("FORBIDDEN", "Simulador indisponível.");
    const order = await db.order.findUnique({ where: { id: orderId }, include: { payments: { where: { status: "PENDING" }, orderBy: { createdAt: "desc" } } } });
    if (!order || order.userId !== user.id) throw new AppError("FORBIDDEN", "Pedido não encontrado.");
    const payment = order.payments[0];
    if (!payment?.providerPaymentId) throw new AppError("INVALID_STATE", "Gere o PIX antes de simular o pagamento.");
    // Mesmo caminho de produção: webhook assinado → verificação → consulta → confirmação.
    const hook = await sim.simulate(payment.providerPaymentId, action);
    const res = await handlePaymentWebhook(db, sim, hook);
    return { result: res.body };
  });
}

/** O comprador pede para reconsultar o status (nunca confia no redirect). */
export async function refreshPaymentStatusAction(orderId: string) {
  const user = await requireUser(`/pedido/${orderId}`);
  const order = await db.order.findUnique({ where: { id: orderId }, include: { payments: { where: { status: "PENDING" } } } });
  if (!order || order.userId !== user.id) return;
  const adapter = getPaymentAdapter();
  for (const p of order.payments) {
    if (p.providerPaymentId && p.provider === adapter.id) await syncPaymentFromProvider(db, adapter, p.providerPaymentId).catch(() => {});
  }
  refresh();
}

export async function cancelOrderAction(orderId: string) {
  const user = await requireUser(`/pedido/${orderId}`);
  await cancelPendingOrder(db, user, orderId);
  redirect(`/pedido/${orderId}`);
}

export async function requestRefundAction(orderId: string): Promise<ActionResult<{ status: string }>> {
  const user = await requireUser(`/pedido/${orderId}`);
  const result = await toActionResult(async () => ({ status: (await requestCustomerRefund(db, getPaymentAdapter(), user, orderId)).status }));
  if (result.ok) refresh();
  return result;
}
