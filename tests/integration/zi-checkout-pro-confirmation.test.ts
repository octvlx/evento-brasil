// Confirmação de pagamentos do Checkout Pro (Mercado Pago): a tentativa é uma preferência
// sem id de pagamento; o id só aparece quando o comprador paga. A confirmação precisa
// funcionar pelo webhook e também sem ele (reconciliação pela página do pedido).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DUPLICATE_PAYMENT_FLAG, VALID_PAID_PAYMENTS, type PaymentProviderAdapter, type ProviderPaymentSnapshot } from "@/server/payments/types";
import { applyPaymentSnapshot, handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { reconcileOrderPayments } from "@/server/services/reconciliation";
import { buy, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

/** Adaptador de teste com o mesmo id do provedor dos pedidos de teste. */
function checkoutAdapter() {
  return {
    id: "simulated",
    isSimulated: true,
    supportedMethods: ["PIX", "CREDIT_CARD"],
    createPayment: vi.fn(),
    refundPayment: vi.fn(),
    getPayment: vi.fn<PaymentProviderAdapter["getPayment"]>(),
    verifyWebhook: vi.fn<PaymentProviderAdapter["verifyWebhook"]>(),
    findCheckoutPayment: vi.fn<NonNullable<PaymentProviderAdapter["findCheckoutPayment"]>>(),
  } satisfies PaymentProviderAdapter;
}

async function checkoutOrder(quantity = 2) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const order = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity }]);
  const payment = await createAttempt(order.id, order.totalCents, 1);
  return { buyer, order, payment, event };
}

function createAttempt(orderId: string, amountCents: number, n: number) {
  return db.payment.create({
    data: {
      orderId,
      provider: "simulated",
      method: "CREDIT_CARD",
      amountCents,
      isSimulated: true,
      idempotencyKey: `${orderId}:CREDIT_CARD:${n}`,
      providerPreferenceId: `pref-${orderId}-${n}`,
      checkoutUrl: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=x",
      providerRawStatus: "preference_created",
    },
  });
}

function snapshot(paymentId: string, amountCents: number, over: Partial<ProviderPaymentSnapshot> = {}): ProviderPaymentSnapshot {
  return {
    providerPaymentId: "187330752002",
    externalReference: paymentId,
    status: "PAID",
    rawStatus: "approved:accredited",
    amountCents,
    processingFeeCents: 898,
    ...over,
  };
}

async function state(orderId: string) {
  const [order, payments, tickets, ledger] = await Promise.all([
    db.order.findUniqueOrThrow({ where: { id: orderId } }),
    db.payment.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
    db.issuedTicket.count({ where: { orderId } }),
    db.financialLedgerEntry.count({ where: { orderId } }),
  ]);
  return { order, payments, tickets, ledger };
}

describe("Checkout Pro: confirmação com e sem webhook", () => {
  it("webhook aprovado confirma o pedido pela referência externa (Payment.id ≠ Order.id)", async () => {
    const { order, payment } = await checkoutOrder();
    expect(payment.id).not.toBe(order.id);
    const a = checkoutAdapter();
    a.verifyWebhook.mockResolvedValue({ valid: true, externalEventId: "evt-1", eventType: "payment.created", providerPaymentId: "187330752002", providerAccountId: "3809512448", payload: {} });
    a.getPayment.mockResolvedValue(snapshot(payment.id, order.totalCents));
    const res = await handlePaymentWebhook(db, a, { headers: new Headers(), rawBody: "{}", url: new URL("https://x.test") });
    expect(res).toEqual({ status: 200, body: "paid" });
    const s = await state(order.id);
    expect(s.order.status).toBe("PAID");
    expect(s.payments[0]).toMatchObject({ status: "PAID", providerPaymentId: "187330752002", processingFeeCents: 898 });
    expect(s.tickets).toBe(2);
    // Aviso repetido do provedor: nada muda.
    expect(await handlePaymentWebhook(db, a, { headers: new Headers(), rawBody: "{}", url: new URL("https://x.test") })).toEqual({ status: 200, body: "duplicate" });
    expect(await state(order.id)).toMatchObject({ tickets: 2, ledger: s.ledger });
  });

  it("sem webhook: a reconciliação do pedido encontra o pagamento aprovado e emite os ingressos uma vez", async () => {
    const { order, payment } = await checkoutOrder();
    const a = checkoutAdapter();
    a.findCheckoutPayment.mockResolvedValue(snapshot(payment.id, order.totalCents));
    expect(await reconcileOrderPayments(db, a, order.id)).toBe("updated");
    expect(a.findCheckoutPayment).toHaveBeenCalledWith(payment.idempotencyKey);
    const first = await state(order.id);
    expect(first.order.status).toBe("PAID");
    expect(first.tickets).toBe(2);
    // Repetições (polling da página) não duplicam ingressos nem lançamentos.
    expect(await reconcileOrderPayments(db, a, order.id)).toBe("unchanged");
    expect(await state(order.id)).toMatchObject({ tickets: 2, ledger: first.ledger });
  });

  it("webhook e reconciliação concorrentes: ingressos e lançamentos exatamente uma vez", async () => {
    const { order, payment } = await checkoutOrder(3);
    const a = checkoutAdapter();
    const approved = snapshot(payment.id, order.totalCents);
    a.findCheckoutPayment.mockResolvedValue(approved);
    const outcomes = await Promise.all([
      applyPaymentSnapshot(db, a, approved),
      applyPaymentSnapshot(db, a, approved),
      reconcileOrderPayments(db, a, order.id),
      reconcileOrderPayments(db, a, order.id),
    ]);
    // Quem pegar a trava primeiro confirma: o webhook devolve "paid"; a reconciliação, "updated".
    expect(outcomes.filter((o) => o === "paid" || o === "updated")).toHaveLength(1);
    const s = await state(order.id);
    expect(s.tickets).toBe(3);
    expect(await db.financialLedgerEntry.count({ where: { orderId: order.id, type: "SALE" } })).toBeGreaterThan(0);
    const sales = await db.financialLedgerEntry.groupBy({ by: ["type", "account", "direction"], where: { orderId: order.id }, _count: true });
    expect(sales.every((g) => g._count === 1)).toBe(true);
  });

  it("cartão recusado e depois saldo aprovado no mesmo checkout: o pedido é confirmado", async () => {
    const { order, payment } = await checkoutOrder();
    const a = checkoutAdapter();
    const rejected = snapshot(payment.id, order.totalCents, { providerPaymentId: "1001", status: "FAILED", rawStatus: "rejected:cc_rejected_other_reason", processingFeeCents: null });
    expect(await applyPaymentSnapshot(db, a, rejected)).toBe("payment_failed");
    let s = await state(order.id);
    expect(s.order.status).toBe("PENDING_PAYMENT");
    expect(s.payments[0]).toMatchObject({ status: "FAILED", providerPaymentId: "1001" });
    expect(s.tickets).toBe(0);
    // Aviso atrasado da recusa depois da aprovação não desfaz nada.
    expect(await applyPaymentSnapshot(db, a, snapshot(payment.id, order.totalCents, { providerPaymentId: "1002" }))).toBe("paid");
    expect(await applyPaymentSnapshot(db, a, rejected)).toBe("no_change");
    s = await state(order.id);
    expect(s.order.status).toBe("PAID");
    expect(s.payments[0]).toMatchObject({ status: "PAID", providerPaymentId: "1002", failureReason: null });
    expect(s.tickets).toBe(2);
  });

  it("segundo pagamento aprovado para a mesma tentativa já paga: vira Payment marcado para reembolso, sem novos ingressos", async () => {
    const { order, payment } = await checkoutOrder();
    const a = checkoutAdapter();
    await applyPaymentSnapshot(db, a, snapshot(payment.id, order.totalCents));
    const before = await state(order.id);
    expect(await applyPaymentSnapshot(db, a, snapshot(payment.id, order.totalCents, { providerPaymentId: "999" }))).toBe("duplicate_payment");
    const after = await state(order.id);
    expect(after).toMatchObject({ tickets: before.tickets, ledger: before.ledger });
    const duplicate = after.payments.find((p) => p.providerPaymentId === "999")!;
    expect(duplicate).toMatchObject({ status: "PAID", failureReason: DUPLICATE_PAYMENT_FLAG, amountCents: order.totalCents });
    // A tentativa original continua sendo o pagamento do pedido.
    expect(after.payments.find((p) => p.id === payment.id)).toMatchObject({ status: "PAID", providerPaymentId: "187330752002", failureReason: null });
    expect(await db.auditLog.count({ where: { action: "payment.duplicate_provider_payment", entityId: duplicate.id } })).toBe(1);
    // Aviso repetido do mesmo pagamento duplicado: nada muda.
    expect(await applyPaymentSnapshot(db, a, snapshot(payment.id, order.totalCents, { providerPaymentId: "999" }))).toBe("duplicate_payment");
    expect(await state(order.id)).toMatchObject({ tickets: before.tickets, ledger: before.ledger, payments: { length: 2 } });
    // O reembolso do pedido usa o pagamento válido, nunca o duplicado.
    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: VALID_PAID_PAYMENTS } });
    expect(paid.payments.map((p) => p.id)).toEqual([payment.id]);
  });

  it("estorno do pagamento duplicado no provedor não reembolsa o pedido nem revoga os ingressos", async () => {
    const { order, payment } = await checkoutOrder();
    const a = checkoutAdapter();
    await applyPaymentSnapshot(db, a, snapshot(payment.id, order.totalCents));
    await applyPaymentSnapshot(db, a, snapshot(payment.id, order.totalCents, { providerPaymentId: "999" }));
    const before = await state(order.id);
    expect(await applyPaymentSnapshot(db, a, snapshot(payment.id, order.totalCents, { providerPaymentId: "999", status: "REFUNDED", rawStatus: "refunded" }))).toBe("duplicate_payment");
    const after = await state(order.id);
    expect(after.order.status).toBe("PAID");
    expect(after.ledger).toBe(before.ledger);
    expect(await db.issuedTicket.count({ where: { orderId: order.id, status: "VALID" } })).toBe(before.tickets);
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(0);
    expect(after.payments.find((p) => p.providerPaymentId === "999")).toMatchObject({ status: "REFUNDED", failureReason: DUPLICATE_PAYMENT_FLAG });
  });

  it("valor divergente não confirma o pedido", async () => {
    const { order, payment } = await checkoutOrder();
    const a = checkoutAdapter();
    a.findCheckoutPayment.mockResolvedValue(snapshot(payment.id, order.totalCents - 1));
    await reconcileOrderPayments(db, a, order.id);
    const s = await state(order.id);
    expect(s.order.status).toBe("PENDING_PAYMENT");
    expect(s.payments[0].failureReason).toBe("AMOUNT_MISMATCH");
    expect(s.tickets).toBe(0);
  });

  it("pagamento de outro pedido não confirma o pedido consultado", async () => {
    const mine = await checkoutOrder();
    const other = await checkoutOrder();
    const a = checkoutAdapter();
    a.findCheckoutPayment.mockResolvedValue(snapshot(other.payment.id, other.order.totalCents));
    await reconcileOrderPayments(db, a, mine.order.id);
    expect((await state(mine.order.id)).order.status).toBe("PENDING_PAYMENT");
    expect((await state(mine.order.id)).tickets).toBe(0);
  });

  it("PIX pendente não emite ingresso; a aprovação posterior emite", async () => {
    const { order, payment } = await checkoutOrder(1);
    await db.payment.update({ where: { id: payment.id }, data: { method: "PIX" } });
    const a = checkoutAdapter();
    a.findCheckoutPayment.mockResolvedValueOnce(snapshot(payment.id, order.totalCents, { status: "PENDING", rawStatus: "pending:pending_waiting_transfer", processingFeeCents: null }));
    expect(await reconcileOrderPayments(db, a, order.id)).toBe("unchanged");
    expect(await state(order.id)).toMatchObject({ order: { status: "PENDING_PAYMENT" }, tickets: 0, payments: [{ status: "PENDING", providerPaymentId: "187330752002" }] });
    a.findCheckoutPayment.mockResolvedValueOnce(snapshot(payment.id, order.totalCents));
    expect(await reconcileOrderPayments(db, a, order.id)).toBe("updated");
    expect(await state(order.id)).toMatchObject({ order: { status: "PAID" }, tickets: 1 });
  });

  it("checkout ainda sem pagamento: nada muda e a tentativa continua aberta", async () => {
    const { order } = await checkoutOrder();
    const a = checkoutAdapter();
    a.findCheckoutPayment.mockResolvedValue(null);
    expect(await reconcileOrderPayments(db, a, order.id)).toBe("unchanged");
    expect((await state(order.id)).payments[0]).toMatchObject({ status: "PENDING", providerPaymentId: null });
  });

  it("falha temporária do provedor: 'unavailable', sem alterar o pedido", async () => {
    const { order } = await checkoutOrder();
    const a = checkoutAdapter();
    a.findCheckoutPayment.mockRejectedValue(new Error("503"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await reconcileOrderPayments(db, a, order.id)).toBe("unavailable");
    expect(await state(order.id)).toMatchObject({ order: { status: "PENDING_PAYMENT" }, tickets: 0 });
  });

  it("pedido que não aguarda pagamento não consulta o provedor", async () => {
    const { order } = await checkoutOrder();
    await db.order.update({ where: { id: order.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const a = checkoutAdapter();
    expect(await reconcileOrderPayments(db, a, order.id)).toBe("unchanged");
    expect(a.findCheckoutPayment).not.toHaveBeenCalled();
  });

  it("'Voltar ao pagamento' não reabre um checkout que já recebeu pagamento (evita cobrança dupla)", async () => {
    const { buyer, order, payment } = await checkoutOrder();
    const a = checkoutAdapter();
    // Nada pago ainda: devolve a mesma preferência, sem criar outra cobrança.
    a.findCheckoutPayment.mockResolvedValueOnce(null);
    expect((await startPayment(db, a, buyer, order.id, "CREDIT_CARD")).id).toBe(payment.id);
    // Cartão recusado no checkout: ainda pode tentar de novo na mesma preferência.
    a.findCheckoutPayment.mockResolvedValueOnce(snapshot(payment.id, order.totalCents, { providerPaymentId: "1", status: "FAILED", rawStatus: "rejected:cc_rejected_other_reason" }));
    expect((await startPayment(db, a, buyer, order.id, "CREDIT_CARD")).id).toBe(payment.id);
    // Provedor indisponível: recusa em vez de reabrir às cegas.
    a.findCheckoutPayment.mockRejectedValueOnce(new Error("503"));
    await expect(startPayment(db, a, buyer, order.id, "CREDIT_CARD")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    // Já pago (webhook atrasado): confirma o pedido e recusa reabrir o checkout.
    a.findCheckoutPayment.mockResolvedValueOnce(snapshot(payment.id, order.totalCents));
    await expect(startPayment(db, a, buyer, order.id, "CREDIT_CARD")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await state(order.id)).toMatchObject({ order: { status: "PAID" }, tickets: 2 });
    expect(a.createPayment).not.toHaveBeenCalled();
  });
});
