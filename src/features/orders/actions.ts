"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import type { CreateOrderInput } from "@/features/schemas";
import { db } from "@/server/db";
import { env, isProduction } from "@/server/env";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { getCurrentUser, requireAdmin, requireUser } from "@/server/auth/current";
import { getPaymentAdapter, getSimulatedAdapter } from "@/server/payments";
import { cancelPendingOrder, createOrder } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment, syncPaymentFromProvider } from "@/server/services/payments";
import { adminRestoreAfterFailedRefund, adminRetryRefund, requestCustomerRefund, type RestoreOutcome } from "@/server/services/refunds";
import type { SimulatedAction } from "@/server/payments/simulated";
import { assertCanCreateOrder, assertCanStartPayment } from "./limits";

// Mesmo critério das ações de autenticação. O primeiro x-forwarded-for só é
// confiável atrás de um proxy que o sobrescreve; o limite por conta vale sempre.
async function clientKey() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
}

export async function createOrderAction(input: CreateOrderInput): Promise<ActionResult<{ orderId: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Entre na sua conta para continuar.", code: "UNAUTHENTICATED" };
  const client = await clientKey();
  return toActionResult(async () => {
    assertCanCreateOrder(user.id, client);
    const order = await createOrder(db, user, input, { providerIsSimulated: getPaymentAdapter().isSimulated });
    return { orderId: order.id };
  });
}

export async function startPaymentAction(orderId: string, method: "PIX" | "CREDIT_CARD", simulatedCardOutcome?: "approve" | "decline") {
  const user = await requireUser(`/checkout/${orderId}`);
  const client = await clientKey();
  const result = await toActionResult(async () => {
    assertCanStartPayment(user.id, client);
    return startPayment(db, getPaymentAdapter(), user, orderId, method, { simulatedCardOutcome });
  });
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

// Decisões do admin sobre reembolsos FAILED (contrato em docs/areas/financeiro.md).
// A tela fica em /admin (agente admin); a fila vem de `listFailedRefunds`.

export async function adminRetryFailedRefundAction(refundId: string, note: string): Promise<ActionResult<{ status: string }>> {
  const admin = await requireAdmin();
  const result = await toActionResult(async () => ({ status: (await adminRetryRefund(db, getPaymentAdapter(), admin, refundId, note)).status }));
  if (result.ok) refresh();
  return result;
}

export async function adminRestoreFailedRefundAction(refundId: string, note: string): Promise<ActionResult<{ outcome: RestoreOutcome; restoredTickets: number }>> {
  const admin = await requireAdmin();
  const result = await toActionResult(() => adminRestoreAfterFailedRefund(db, getPaymentAdapter(), admin, refundId, note));
  if (result.ok) refresh();
  return result;
}
