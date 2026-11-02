// Pagamentos: início do checkout, processamento de webhooks e aplicação do
// status autoritativo do provedor. Um redirect de checkout NUNCA confirma
// pagamento; só `getPayment` no provedor, após webhook verificado ou consulta.
import "server-only";
import type { Payment, Prisma } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "../db";
import { audit } from "../audit";
import { assertActive, type Actor } from "../auth/permissions";
import { AppError, forbidden, invalidState, notFound } from "../errors";
import { DUPLICATE_PAYMENT_FLAG, PaymentNotStartedError, type PaymentProviderAdapter, type ProviderPaymentSnapshot, type WebhookRequest } from "../payments/types";
import { assertCheckoutReviewed } from "./checkout-review";
import { financeLog } from "./finance-log";
import { postProcessingFee, postReversal, postSale } from "./ledger";
import { acquireLateInventoryTx, finalizePaidOrderTx, lockEvent, lockOrder, releaseOrderTx } from "./orders";
import { notifyOrderPaid } from "./notifications";
import { closePendingTransfersTx, confirmRefundTx, processRefund } from "./refunds";

export async function startPayment(
  db: Db,
  adapter: PaymentProviderAdapter,
  actor: Actor,
  orderId: string,
  method: "PIX" | "CREDIT_CARD",
  opts: { simulatedCardOutcome?: "approve" | "decline" } = {},
) {
  assertActive(actor);
  if (!adapter.supportedMethods.includes(method)) throw new AppError("VALIDATION", "Forma de pagamento indisponível.");

  // Decisão sob trava da linha do pedido: no máximo UMA tentativa ativa por pedido.
  // Sem a trava, cliques simultâneos criavam duas cobranças (PIX ou cartão).
  const decision = await db.$transaction(async (tx) => {
    const exists = await tx.order.findUnique({ where: { id: orderId }, select: { userId: true } });
    if (!exists) throw notFound("Pedido não encontrado.");
    if (exists.userId !== actor.id) throw forbidden();
    await lockOrder(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { event: { select: { title: true } }, organization: true } });
    await assertCheckoutReviewed(tx, order);
    if (order.status !== "PENDING_PAYMENT") throw invalidState("Este pedido não está aguardando pagamento.");
    if (order.expiresAt <= new Date()) throw new AppError("SALES_CLOSED", "A reserva expirou. Faça um novo pedido.");
    if (order.totalCents === 0) throw invalidState("Pedido gratuito não requer pagamento.");
    if (order.isSimulated !== adapter.isSimulated) throw invalidState("Pedido criado com outro provedor de pagamento.");

    const active = await tx.payment.findMany({ where: { orderId, status: { in: ["PENDING", "PAID"] } }, orderBy: { createdAt: "asc" } });
    if (active.some((p) => p.status === "PAID")) throw invalidState("Este pedido já foi pago.");
    const pending = active.find((p) => p.status === "PENDING");
    if (pending) {
      // PIX pendente é reaproveitado (mesmo QR). Qualquer outra combinação aguardaria
      // uma tentativa em andamento — recusada para não gerar cobrança dupla.
      const samePix = pending.method === "PIX" && method === "PIX" && pending.provider === adapter.id;
      if (samePix && (pending.providerPaymentId || pending.checkoutUrl)) return { kind: "reuse", payment: pending } as const;
      // PIX ainda sendo criado por outra requisição (duplo clique): espera o id do
      // provedor fora da transação. Se a criação ficou incerta, não reaproveita.
      if (samePix && !pending.failureReason) return { kind: "await", paymentId: pending.id } as const;
      // Cartão pelo Checkout Pro: a tentativa pendente já tem página de pagamento; reaproveita.
      if (pending.method === method && pending.provider === adapter.id && pending.checkoutUrl) return { kind: "reuse", payment: pending } as const;
      throw invalidState(
        pending.method === "PIX"
          ? "Já existe um PIX gerado para este pedido. Conclua o pagamento ou aguarde a expiração da reserva."
          : "Já há um pagamento com cartão em processamento para este pedido. Aguarde o resultado.",
      );
    }
    const attempts = await tx.payment.count({ where: { orderId } });
    const payment = await tx.payment.create({
      data: {
        orderId,
        provider: adapter.id,
        method,
        amountCents: order.totalCents,
        isSimulated: adapter.isSimulated,
        idempotencyKey: `${orderId}:${method}:${attempts + 1}`,
      },
    });
    return { kind: "new", payment, order } as const;
  }, TX_OPTIONS);
  if (decision.kind === "reuse") return guardReusedCheckout(db, adapter, decision.payment);
  if (decision.kind === "await") return awaitPixInFlight(db, decision.paymentId);
  const { payment, order } = decision;

  // Chamada externa FORA da transação; a chave de idempotência torna a repetição segura.
  let created;
  try {
    created = await adapter.createPayment({
      paymentId: payment.id,
      amountCents: order.totalCents,
      orderId: order.id,
      method,
      description: `${order.event.title} — pedido ${order.publicCode}`,
      payer: { email: order.buyerEmail, name: order.buyerName },
      expiresAt: order.expiresAt,
      idempotencyKey: payment.idempotencyKey,
      marketplace: {
        organizationId: order.organizationId,
        sellerAccountId: order.organization.paymentAccountExternalId,
        applicationFeeCents: order.commissionCents,
      },
      simulatedCardOutcome: opts.simulatedCardOutcome,
    });
  } catch (err) {
    // Recusa nas verificações prévias: nenhuma cobrança pode existir no provedor.
    // Encerra a tentativa como falha (libera nova tentativa) com mensagem clara.
    if (err instanceof PaymentNotStartedError) {
      await db.payment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "FAILED", failureReason: err.reason } });
      await audit(db, { actorUserId: actor.id, organizationId: order.organizationId, action: "payment.not_started", entityType: "Payment", entityId: payment.id, metadata: { method, reason: err.reason } });
      throw err;
    }
    // Uma falha de transporte não prova que o provedor deixou de cobrar.
    // Mantém a tentativa bloqueando novas cobranças até a reconciliação resolver a referência.
    await db.payment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { failureReason: "PROVIDER_CREATE_UNCERTAIN" } });
    if (err instanceof AppError) throw err;
    throw new AppError("PROVIDER_ERROR", "Estamos confirmando o pagamento com o provedor. Acompanhe seu pedido antes de tentar novamente.");
  }
  const updated = await db.payment.update({
    where: { id: payment.id },
    data: {
      providerPaymentId: created.providerPaymentId,
      providerPreferenceId: created.providerPreferenceId,
      providerRawStatus: created.rawStatus,
      pixCopyPaste: created.pixCopyPaste,
      pixQrCodeBase64: created.pixQrCodeBase64,
      checkoutUrl: created.checkoutUrl,
      providerExpiresAt: created.expiresAt ?? order.expiresAt,
    },
  });
  await audit(db, { actorUserId: actor.id, organizationId: order.organizationId, action: "payment.started", entityType: "Payment", entityId: payment.id, metadata: { method } });
  // Resultado síncrono (ex.: cartão) é revalidado na consulta autoritativa.
  if (created.status !== "PENDING" && created.providerPaymentId) await syncPaymentFromProvider(db, adapter, created.providerPaymentId);
  return db.payment.findUniqueOrThrow({ where: { id: updated.id } });
}

/**
 * Antes de devolver o comprador a um checkout hospedado já criado, confere se ele já
 * recebeu pagamento. Com o webhook atrasado, um pedido pago continuava pendente e
 * "Voltar ao pagamento" reabria a mesma preferência, permitindo cobrar de novo.
 * Sem resposta do provedor, recusa: reabrir às cegas arrisca cobrança dupla.
 */
async function guardReusedCheckout(db: Db, adapter: PaymentProviderAdapter, payment: Payment) {
  if (!payment.providerPreferenceId || !adapter.findCheckoutPayment) return payment;
  let snapshot: ProviderPaymentSnapshot | null;
  try {
    snapshot = await adapter.findCheckoutPayment(payment.idempotencyKey);
  } catch {
    throw new AppError("PROVIDER_ERROR", "Não foi possível conferir o pagamento com o provedor agora. Tente novamente em instantes.");
  }
  if (!snapshot || snapshot.status === "FAILED" || snapshot.status === "CANCELLED") return payment;
  await applyPaymentSnapshot(db, adapter, snapshot);
  throw invalidState(
    snapshot.status === "PENDING"
      ? "Há um pagamento em análise para este pedido. Acompanhe o resultado na página do pedido."
      : "Este pedido já foi pago. Acompanhe a confirmação na página do pedido.",
  );
}

const PIX_IN_FLIGHT_WAIT_MS = 10_000;
const PIX_IN_FLIGHT_POLL_MS = 100;

/**
 * Espera a requisição concorrente terminar de criar o PIX e devolve o mesmo
 * pagamento (mesmo QR). Só reaproveita quando o provedor confirmou a cobrança
 * (`providerPaymentId`); criação incerta, falha ou demora → recusa, sem nova cobrança.
 */
async function awaitPixInFlight(db: Db, paymentId: string) {
  const deadline = Date.now() + PIX_IN_FLIGHT_WAIT_MS;
  for (;;) {
    const p = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if ((p.providerPaymentId || p.checkoutUrl) && p.status !== "FAILED" && p.status !== "CANCELLED" && p.status !== "EXPIRED") return p;
    if (p.failureReason || p.status !== "PENDING" || Date.now() >= deadline) {
      throw invalidState("Já existe um PIX gerado para este pedido. Conclua o pagamento ou aguarde a expiração da reserva.");
    }
    await new Promise((r) => setTimeout(r, PIX_IN_FLIGHT_POLL_MS));
  }
}

/** Consulta o provedor e aplica o status retornado. */
export async function syncPaymentFromProvider(
  db: Db,
  adapter: PaymentProviderAdapter,
  providerPaymentId: string,
  providerAccountId?: string,
) {
  const payment = providerAccountId
    ? null
    : await db.payment.findFirst({
        where: { provider: adapter.id, providerPaymentId },
        select: { order: { select: { organizationId: true } } },
      });
  const snapshot = await adapter.getPayment(providerPaymentId, {
    organizationId: payment?.order.organizationId,
    providerAccountId,
  });
  return applyPaymentSnapshot(db, adapter, snapshot);
}

/**
 * Volta do checkout externo (Checkout Pro): o `payment_id` da URL é só uma pista.
 * O status vem da consulta autenticada ao provedor com a conta do vendedor deste
 * pedido, e só é aplicado se a referência externa do pagamento for uma tentativa
 * deste pedido (o valor é conferido em `applyPaymentSnapshot`). Também vincula o
 * id do pagamento, para as próximas consultas e a reconciliação.
 */
export async function confirmReturnedPayment(db: Db, adapter: PaymentProviderAdapter, actor: Actor, orderId: string, providerPaymentId: string) {
  if (!/^\d{1,24}$/.test(providerPaymentId)) return "ignored" as const;
  const order = await db.order.findUnique({ where: { id: orderId }, select: { userId: true, organizationId: true, payments: { where: { provider: adapter.id }, select: { id: true, status: true, providerPaymentId: true } } } });
  if (!order || order.userId !== actor.id) return "ignored" as const;
  const open = order.payments.some((p) => p.status === "PENDING" || p.providerPaymentId === providerPaymentId);
  if (!open) return "ignored" as const;
  const snapshot = await adapter.getPayment(providerPaymentId, { organizationId: order.organizationId });
  if (!snapshot.externalReference || !order.payments.some((p) => p.id === snapshot.externalReference)) return "ignored" as const;
  return applyPaymentSnapshot(db, adapter, snapshot);
}

export type ApplyOutcome =
  | "unknown_payment"
  | "amount_mismatch"
  | "paid"
  | "late_paid"
  | "late_payment_refund"
  | "already_processed"
  | "duplicate_payment"
  | "payment_failed"
  | "payment_expired"
  | "refunded"
  | "charged_back"
  | "disputed"
  | "dispute_resolved"
  | "no_change";

/** Aplica um snapshot autoritativo do provedor. Idempotente e seguro contra concorrência. */
export async function applyPaymentSnapshot(db: Db, adapter: PaymentProviderAdapter, snapshot: ProviderPaymentSnapshot): Promise<ApplyOutcome> {
  const linked = await db.payment.findUnique({
    where: { provider_providerPaymentId: { provider: adapter.id, providerPaymentId: snapshot.providerPaymentId } },
    select: { id: true, orderId: true, order: { select: { eventId: true } } },
  });
  // A referência externa é o nosso Payment.id (uma tentativa = uma preferência do Checkout Pro).
  const ref = linked ?? await db.payment.findFirst({
    where: { id: snapshot.externalReference, provider: adapter.id },
    select: { id: true, orderId: true, order: { select: { eventId: true } } },
  });
  if (!ref) return "unknown_payment";
  let followUpRefundId: string | null = null;

  const outcome = await db.$transaction(async (tx): Promise<ApplyOutcome> => {
    await lockEvent(tx, ref.order.eventId);
    await lockOrder(tx, ref.orderId);
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: ref.id } });
    const unsettled = ["PENDING", "FAILED", "CANCELLED", "EXPIRED"].includes(payment.status);
    if (payment.providerPaymentId && payment.providerPaymentId !== snapshot.providerPaymentId) {
      // Outra tentativa no mesmo checkout: o comprador pode ter um cartão recusado e
      // depois pagar com saldo. Só a tentativa aprovada substitui a vinculada.
      if (snapshot.status !== "PAID") return "no_change";
      if (!unsettled) {
        // Segundo pagamento aprovado no mesmo checkout: vira um Payment próprio, marcado
        // para reembolso manual (aparece em /admin/pagamentos), fora do razão e do pedido.
        const duplicate = await tx.payment.create({
          data: {
            orderId: payment.orderId,
            provider: payment.provider,
            providerPaymentId: snapshot.providerPaymentId,
            providerPreferenceId: payment.providerPreferenceId,
            method: payment.method,
            status: "PAID",
            amountCents: snapshot.amountCents,
            providerRawStatus: snapshot.rawStatus,
            failureReason: DUPLICATE_PAYMENT_FLAG,
            isSimulated: payment.isSimulated,
            idempotencyKey: `${payment.idempotencyKey}:duplicate:${snapshot.providerPaymentId}`,
            paidAt: new Date(),
          },
        });
        await audit(tx, {
          action: "payment.duplicate_provider_payment",
          entityType: "Payment",
          entityId: duplicate.id,
          metadata: { attemptPaymentId: payment.id, providerPaymentId: snapshot.providerPaymentId },
        });
        return "duplicate_payment";
      }
      await tx.payment.update({ where: { id: payment.id }, data: { providerPaymentId: snapshot.providerPaymentId, failureReason: null } });
    } else if (!payment.providerPaymentId) {
      // Encerrada sem vínculo (ex.: reserva expirada): só um pagamento aprovado a reabre,
      // para nunca ignorar dinheiro recebido; o ramo PAID trata o pagamento tardio.
      if (payment.status !== "PENDING" && !(snapshot.status === "PAID" && unsettled)) return "no_change";
      await tx.payment.update({
        where: { id: payment.id },
        data: { providerPaymentId: snapshot.providerPaymentId },
      });
    }
    const order = await tx.order.findUniqueOrThrow({ where: { id: ref.orderId }, include: { items: true, commissionRule: true } });
    const now = new Date();

    // Pagamento duplicado já marcado: só acompanha o status no provedor (ex.: o admin
    // estornou no painel). Nunca mexe no pedido, nos ingressos nem no razão — o
    // pagamento válido do pedido é outro.
    if (payment.failureReason === DUPLICATE_PAYMENT_FLAG) {
      if (snapshot.status !== payment.status && ["REFUNDED", "CHARGED_BACK", "DISPUTED", "PAID"].includes(snapshot.status)) {
        await tx.payment.update({ where: { id: payment.id }, data: { status: snapshot.status, providerRawStatus: snapshot.rawStatus } });
        await audit(tx, { organizationId: order.organizationId, action: "payment.duplicate_status_changed", entityType: "Payment", entityId: payment.id, metadata: { status: snapshot.status } });
      }
      return "duplicate_payment";
    }

    if (snapshot.amountCents !== payment.amountCents || payment.amountCents !== order.totalCents) {
      await tx.payment.update({ where: { id: payment.id }, data: { failureReason: "AMOUNT_MISMATCH", providerRawStatus: snapshot.rawStatus } });
      await audit(tx, {
        organizationId: order.organizationId,
        action: "payment.amount_mismatch",
        entityType: "Payment",
        entityId: payment.id,
        metadata: { provider: snapshot.amountCents, expected: order.totalCents },
      });
      return "amount_mismatch";
    }

    const markPayment = (data: Prisma.PaymentUpdateInput) =>
      tx.payment.update({ where: { id: payment.id }, data: { providerRawStatus: snapshot.rawStatus, ...data } });

    if (payment.status === "PENDING" && snapshot.status === "PENDING" && payment.method === "PIX") {
      await tx.payment.update({ where: { id: payment.id }, data: {
        pixCopyPaste: snapshot.pixCopyPaste,
        pixQrCodeBase64: snapshot.pixQrCodeBase64,
        providerExpiresAt: snapshot.expiresAt,
      } });
    }
    const syncProcessingFee = async () => {
      // null = ainda desconhecida; nunca apaga uma taxa já confirmada.
      if (snapshot.processingFeeCents === null) return;
      await postProcessingFee(tx, order, payment.id, snapshot.processingFeeCents, order.commissionRule?.processingFeeBearer ?? "ORGANIZER");
      if (payment.processingFeeCents !== snapshot.processingFeeCents) {
        await tx.payment.update({ where: { id: payment.id }, data: { processingFeeCents: snapshot.processingFeeCents } });
      }
    };

    switch (snapshot.status) {
      case "PAID": {
        if (payment.status === "DISPUTED") {
          await syncProcessingFee();
          await markPayment({ status: "PAID" });
          if (order.status === "DISPUTED") {
            await tx.order.update({ where: { id: order.id }, data: { status: "PAID" } });
          }
          await audit(tx, { organizationId: order.organizationId, action: "payment.dispute_resolved", entityType: "Payment", entityId: payment.id });
          return "dispute_resolved";
        }
        const wasPaid = payment.status === "PAID";
        if (!wasPaid) {
          if (!["PENDING", "FAILED", "EXPIRED", "CANCELLED"].includes(payment.status)) return "no_change";
          await markPayment({ status: "PAID", paidAt: now });
        }
        if (["PAID", "REFUND_PENDING", "REFUNDED", "DISPUTED"].includes(order.status)) {
          const paidByOther = await tx.payment.count({ where: { orderId: order.id, status: "PAID", NOT: { id: payment.id } } });
          if (!wasPaid && paidByOther > 0) {
            // Segundo pagamento para o mesmo pedido: sinaliza para reembolso manual.
            await markPayment({ failureReason: DUPLICATE_PAYMENT_FLAG });
            await audit(tx, { organizationId: order.organizationId, action: "payment.duplicate", entityType: "Payment", entityId: payment.id });
            return "duplicate_payment";
          }
          if (wasPaid) await syncProcessingFee();
          return "already_processed";
        }
        let result: ApplyOutcome = "paid";
        if (order.status === "PENDING_PAYMENT") {
          await finalizePaidOrderTx(tx, order, now);
        } else if (await acquireLateInventoryTx(tx, order, now)) {
          result = "late_paid";
        } else {
          await tx.order.update({ where: { id: order.id }, data: { status: "REFUND_PENDING", paidAt: now } });
          const refund = await tx.refund.upsert({
            where: { idempotencyKey: `refund:${order.id}:late-payment` },
            create: {
              orderId: order.id,
              paymentId: payment.id,
              amountCents: order.totalCents,
              reason: "LATE_PAYMENT_NO_INVENTORY",
              idempotencyKey: `refund:${order.id}:late-payment`,
              note: "Pagamento confirmado após expiração da reserva, sem estoque disponível.",
            },
            update: {},
          });
          followUpRefundId = refund.id;
          result = "late_payment_refund";
        }
        await postSale(tx, order, payment.id);
        await syncProcessingFee();
        await audit(tx, { organizationId: order.organizationId, action: `payment.${result}`, entityType: "Order", entityId: order.id, metadata: { paymentId: payment.id } });
        return result;
      }
      case "FAILED":
      case "CANCELLED": {
        if (payment.status !== "PENDING") return "no_change";
        await markPayment({ status: snapshot.status, failureReason: snapshot.rawStatus });
        // O pedido continua reservado até expiresAt, permitindo nova tentativa.
        return "payment_failed";
      }
      case "EXPIRED": {
        if (payment.status !== "PENDING") return "no_change";
        await markPayment({ status: "EXPIRED" });
        const stillPending = await tx.payment.count({ where: { orderId: order.id, status: "PENDING", NOT: { id: payment.id } } });
        if (order.status === "PENDING_PAYMENT" && !stillPending) await releaseOrderTx(tx, order.id, "EXPIRED", "payment_expired", now);
        return "payment_expired";
      }
      case "REFUNDED": {
        if (payment.status === "REFUNDED" || payment.status === "CHARGED_BACK") return "no_change";
        let refund = await tx.refund.findFirst({ where: { orderId: order.id, status: { in: ["REQUESTED", "PROCESSING", "FAILED"] } } });
        refund ??= await tx.refund.create({
          data: {
            orderId: order.id,
            paymentId: payment.id,
            amountCents: order.totalCents,
            reason: "ADMIN",
            idempotencyKey: `refund:${order.id}:provider-initiated`,
            note: "Reembolso iniciado diretamente no provedor.",
          },
        });
        await confirmRefundTx(tx, refund.id, now);
        return "refunded";
      }
      case "CHARGED_BACK": {
        if (payment.status === "CHARGED_BACK" || payment.status === "REFUNDED") return "no_change";
        await markPayment({ status: "CHARGED_BACK" });
        await tx.issuedTicket.updateMany({
          where: { orderId: order.id, status: "VALID" },
          data: { status: "REVOKED", revokedAt: now, revocationReason: "CHARGEBACK" },
        });
        await closePendingTransfersTx(tx, { orderId: order.id }, "Pagamento contestado (chargeback)", now);
        await tx.order.update({ where: { id: order.id }, data: { status: "DISPUTED" } });
        // Política padrão: perda do chargeback é do organizador (comissão retida). Revisão necessária.
        await postReversal(tx, "CHARGEBACK", order, { paymentId: payment.id, returnCommission: false });
        await audit(tx, { organizationId: order.organizationId, action: "payment.charged_back", entityType: "Order", entityId: order.id });
        return "charged_back";
      }
      case "DISPUTED": {
        if (payment.status !== "PAID") return "no_change";
        await markPayment({ status: "DISPUTED" });
        if (order.status === "PAID") await tx.order.update({ where: { id: order.id }, data: { status: "DISPUTED" } });
        await audit(tx, { organizationId: order.organizationId, action: "payment.disputed", entityType: "Order", entityId: order.id });
        return "disputed";
      }
      default:
        return "no_change";
    }
  }, TX_OPTIONS);

  if (followUpRefundId) await processRefund(db, adapter, followUpRefundId);
  if (outcome === "paid" || outcome === "late_paid") notifyOrderPaid(db, ref.orderId);
  return outcome;
}

/**
 * Processa um webhook: verifica assinatura, registra o evento (idempotente) e
 * consulta o provedor. Retorna o status HTTP a responder.
 */
export async function handlePaymentWebhook(db: Db, adapter: PaymentProviderAdapter, req: WebhookRequest): Promise<{ status: number; body: string }> {
  const verification = await adapter.verifyWebhook(req);
  if (!verification.valid) {
    console.warn(`[webhook:${adapter.id}] rejeitado: ${verification.reason}`);
    return { status: 401, body: "invalid signature" };
  }
  const key = { provider_externalEventId: { provider: adapter.id, externalEventId: verification.externalEventId } };
  const existing = await db.paymentWebhookEvent.findUnique({ where: key });
  if (existing?.processedAt) return { status: 200, body: "duplicate" };
  const record = existing
    ? await db.paymentWebhookEvent.update({ where: { id: existing.id }, data: { attempts: { increment: 1 } } })
    : await db.paymentWebhookEvent
        .create({
          data: {
            provider: adapter.id,
            externalEventId: verification.externalEventId,
            eventType: verification.eventType,
            providerPaymentId: verification.providerPaymentId,
            payload: verification.payload as Prisma.InputJsonValue,
          },
        })
        .catch(async () => db.paymentWebhookEvent.findUniqueOrThrow({ where: key }));

  if (!verification.providerPaymentId) {
    await db.paymentWebhookEvent.update({ where: { id: record.id }, data: { processedAt: new Date(), processingResult: "ignored_no_payment" } });
    return { status: 200, body: "ignored" };
  }
  try {
    const outcome = await syncPaymentFromProvider(db, adapter, verification.providerPaymentId, verification.providerAccountId);
    await db.paymentWebhookEvent.update({ where: { id: record.id }, data: { processedAt: new Date(), processingResult: outcome, error: null } });
    return { status: 200, body: outcome };
  } catch (err) {
    await db.paymentWebhookEvent.update({ where: { id: record.id }, data: { error: String(err).slice(0, 1000) } });
    const local = await db.payment
      .findFirst({ where: { provider: adapter.id, providerPaymentId: verification.providerPaymentId }, select: { id: true, orderId: true } })
      .catch(() => null);
    financeLog("error", "webhook.processing_failed", { orderId: local?.orderId, paymentId: local?.id, providerPaymentId: verification.providerPaymentId }, {
      provider: adapter.id,
      webhookEventId: record.id,
      message: String(err).slice(0, 300),
    });
    // 500 faz o provedor reenviar; o processamento é idempotente.
    return { status: 500, body: "processing error" };
  }
}
