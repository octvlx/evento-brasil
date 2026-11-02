"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import type { CreateOrderInput } from "@/features/schemas";
import { db } from "@/server/db";
import { env, isProduction } from "@/server/env";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { getCurrentUser, requireAdmin, requireUser } from "@/server/auth/current";
import { getPaymentAdapter, getSimulatedAdapter } from "@/server/payments";
import { checkoutReadiness, createCheckoutDraft, prepareCheckoutReview } from "@/server/services/checkout-review";
import { cancelPendingOrder } from "@/server/services/orders";
import { confirmReturnedPayment, handlePaymentWebhook, startPayment, syncPaymentFromProvider } from "@/server/services/payments";
import { adminRestoreAfterFailedRefund, adminRetryRefund, requestCustomerRefund, type RestoreOutcome } from "@/server/services/refunds";
import type { SimulatedAction } from "@/server/payments/simulated";
import { ATTR_COOKIE, attributionCookieOptions, decodeAttribution, encodeAttribution, utmsFromParams } from "./attribution";
import { assertCanCreateOrder, assertCanStartPayment } from "./limits";
import { checkoutTermsGate, recordAcceptance } from "@/server/services/terms";
import type { TermsKind } from "@/generated/prisma/client";

// Mesmo critério das ações de autenticação. O primeiro x-forwarded-for só é
// confiável atrás de um proxy que o sobrescreve; o limite por conta vale sempre.
async function clientKey() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
}

// Aceite dos termos na compra (R10): com versão vigente não aceita, as ações recusam
// com TERMS_REQUIRED até o comprador marcar o aceite; o aceite é gravado com o pedido.
async function recordCheckoutAcceptance(userId: string, kinds: TermsKind[], orderId: string, ip: string) {
  if (!kinds.length) return;
  await recordAcceptance(db, userId, kinds, { context: "CHECKOUT", orderId, ip, userAgent: (await headers()).get("user-agent") });
}

export async function createOrderAction(input: CreateOrderInput, opts: { acceptTerms?: boolean } = {}): Promise<ActionResult<{ orderId: string }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Entre na sua conta para continuar.", code: "UNAUTHENTICATED" };
  // Atribuição só do cookie primário eb_attr; a enviada pelo cliente é descartada.
  const attribution = decodeAttribution((await cookies()).get(ATTR_COOKIE)?.value);
  const client = await clientKey();
  return toActionResult(async () => {
    assertCanCreateOrder(user.id, client);
    const { readiness } = await checkoutReadiness(db, user.id);
    if (!readiness.email || !readiness.profile || !readiness.address) throw new AppError("VALIDATION", "Confirme seu e-mail e complete CPF, nascimento e endereço no checkout.");
    const pendingTerms = await checkoutTermsGate(db, user.id, opts.acceptTerms);
    const { draftId } = await createCheckoutDraft(db, { ...input, attribution }, user);
    const review = await prepareCheckoutReview(db, user, draftId);
    const order = review.order!;
    await recordCheckoutAcceptance(user.id, pendingTerms, order.id, client);
    return { orderId: order.id };
  });
}

/**
 * UTMs soltos na URL do evento (sem link rastreado): grava no mesmo cookie de
 * atribuição, substituindo o anterior (último clique vence).
 */
export async function captureUtmAction(params: Record<string, string>): Promise<void> {
  const utms = utmsFromParams(params);
  if (utms) (await cookies()).set(ATTR_COOKIE, encodeAttribution(utms), attributionCookieOptions());
}

export async function startPaymentAction(orderId: string, method: "PIX" | "CREDIT_CARD", simulatedCardOutcome?: "approve" | "decline", acceptTerms?: boolean) {
  const user = await requireUser(`/checkout/${orderId}`);
  const client = await clientKey();
  const result = await toActionResult(async () => {
    assertCanStartPayment(user.id, client);
    // Versão nova publicada depois da reserva: aceite antes de cobrar.
    const pendingTerms = await checkoutTermsGate(db, user.id, acceptTerms);
    if (pendingTerms.length) {
      const own = await db.order.findFirst({ where: { id: orderId, userId: user.id }, select: { id: true } });
      if (!own) throw new AppError("FORBIDDEN", "Pedido não encontrado.");
      await recordCheckoutAcceptance(user.id, pendingTerms, orderId, client);
    }
    return startPayment(db, getPaymentAdapter(), user, orderId, method, { simulatedCardOutcome });
  });
  if (!result.ok) return result;
  refresh();
  return {
    ok: true as const,
    data: {
      paymentId: result.data.id,
      status: result.data.status,
      checkoutUrl: result.data.checkoutUrl,
    },
  };
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
export async function refreshPaymentStatusAction(orderId: string, returnedPaymentId?: string) {
  const user = await requireUser(`/pedido/${orderId}`);
  const order = await db.order.findUnique({ where: { id: orderId }, include: { payments: { where: { status: "PENDING" } } } });
  if (!order || order.userId !== user.id) return;
  const adapter = getPaymentAdapter();
  // Volta do Checkout Pro: o id da URL é só uma pista, conferida no provedor.
  if (returnedPaymentId) await confirmReturnedPayment(db, adapter, user, orderId, returnedPaymentId).catch(() => {});
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
