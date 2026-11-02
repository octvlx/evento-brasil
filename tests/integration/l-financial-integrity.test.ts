// Integridade financeira: tentativas de pagamento concorrentes, corrida entre
// reembolso e check-in, guarda contra estorno acima do pago, reconciliação de
// webhooks perdidos / processos interrompidos e verificação de invariantes.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkInTicket } from "@/server/services/checkin";
import { createOrder, expireStaleOrders } from "@/server/services/orders";
import { confirmReturnedPayment, handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { checkFinancialInvariants, reconcilePayments } from "@/server/services/reconciliation";
import { adminRefundOrder, confirmRefundTx, OverRefundError, processRefund, requestCustomerRefund } from "@/server/services/refunds";
import { qrPayload } from "@/server/services/tickets";
import { PaymentNotStartedError } from "@/server/payments/types";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeUser, orderInput, resetDb, ticketType } from "../support/fixtures";

beforeEach(resetDb);
// Toda situação testada aqui deve terminar com o banco consistente.
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
});

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

async function setup(quantityTotal = 50) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal }] });
  return { owner, org, event, tt: event.ticketTypes[0] };
}

describe("tentativas de pagamento concorrentes", () => {
  it("cliques simultâneos em 'Gerar PIX' geram uma única cobrança", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => startPayment(db, adapter, customer, order.id, "PIX")));
    expect(new Set(results.map((p) => p.id)).size).toBe(1);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.simulatedProviderPayment.count()).toBe(1);
  });

  it("duplo clique com provedor lento: os cliques esperam o PIX em criação e recebem o mesmo QR", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const create = adapter.createPayment.bind(adapter);
    // Provedor demora: os outros cliques encontram o PIX pendente ainda sem id do provedor.
    const spy = vi.spyOn(adapter, "createPayment").mockImplementation(async (input) => {
      await new Promise((r) => setTimeout(r, 400));
      return create(input);
    });
    try {
      const results = await Promise.all(Array.from({ length: 4 }, () => startPayment(db, adapter, customer, order.id, "PIX")));
      expect(new Set(results.map((p) => p.id)).size).toBe(1);
      expect(results.every((p) => p.providerPaymentId && p.pixCopyPaste)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await db.simulatedProviderPayment.count()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("volta do checkout externo: confirma pelo provedor, sem confiar na URL", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const intruder = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const other = await buy(intruder, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const create = vi.spyOn(adapter, "createPayment").mockResolvedValue({
      providerPaymentId: null,
      providerPreferenceId: "pref-x",
      status: "PENDING",
      rawStatus: "preference_created",
      checkoutUrl: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-x",
      expiresAt: order.expiresAt,
    });
    const attempt = await startPayment(db, adapter, customer, order.id, "CREDIT_CARD");
    const otherAttempt = await startPayment(db, adapter, intruder, other.id, "CREDIT_CARD");
    create.mockRestore();
    const snapshot = (externalReference: string, amountCents: number) => ({
      providerPaymentId: "187330752002",
      externalReference,
      status: "PAID" as const,
      rawStatus: "approved:accredited",
      amountCents,
      processingFeeCents: 0,
    });
    const get = vi.spyOn(adapter, "getPayment");
    try {
      // Pista malformada: nem consulta o provedor.
      expect(await confirmReturnedPayment(db, adapter, customer, order.id, "abc")).toBe("ignored");
      // Outro comprador não confirma este pedido.
      expect(await confirmReturnedPayment(db, adapter, intruder, order.id, "187330752002")).toBe("ignored");
      expect(get).not.toHaveBeenCalled();
      // Pagamento de OUTRO pedido apresentado na volta: ignorado.
      get.mockResolvedValueOnce(snapshot(otherAttempt.id, other.totalCents));
      expect(await confirmReturnedPayment(db, adapter, customer, order.id, "187330752002")).toBe("ignored");
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PAYMENT");
      // Pagamento desta tentativa, aprovado no provedor: confirma e vincula o id.
      get.mockResolvedValueOnce(snapshot(attempt.id, order.totalCents));
      expect(await confirmReturnedPayment(db, adapter, customer, order.id, "187330752002")).toBe("paid");
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
      expect(await db.payment.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: "PAID", providerPaymentId: "187330752002" });
      expect(get).toHaveBeenLastCalledWith("187330752002", { organizationId: order.organizationId });
    } finally {
      get.mockRestore();
      await db.order.update({ where: { id: other.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    }
  });

  it("cartão por checkout externo: nova chamada reaproveita a mesma página, sem segunda cobrança", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const spy = vi.spyOn(adapter, "createPayment").mockResolvedValue({
      providerPaymentId: null,
      providerPreferenceId: "pref-card",
      status: "PENDING",
      rawStatus: "preference_created",
      checkoutUrl: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-card",
      expiresAt: order.expiresAt,
    });
    try {
      const first = await startPayment(db, adapter, customer, order.id, "CREDIT_CARD");
      const again = await startPayment(db, adapter, customer, order.id, "CREDIT_CARD");
      expect(again.id).toBe(first.id);
      expect(again.checkoutUrl).toBe(first.checkoutUrl);
      expect(spy).toHaveBeenCalledTimes(1);
      // Trocar para PIX com o cartão pendente continua recusado (uma tentativa ativa por pedido).
      await expect(startPayment(db, adapter, customer, order.id, "PIX")).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
      await db.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    } finally {
      spy.mockRestore();
    }
  });

  it("recusa nas verificações prévias (ex.: conta sem PIX) encerra a tentativa e libera nova tentativa", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const spy = vi
      .spyOn(adapter, "createPayment")
      .mockRejectedValueOnce(new PaymentNotStartedError("PIX_UNAVAILABLE", "O organizador deste evento ainda não pode receber por PIX."));
    try {
      await expect(startPayment(db, adapter, customer, order.id, "PIX")).rejects.toMatchObject({ code: "PROVIDER_ERROR", reason: "PIX_UNAVAILABLE" });
      const failed = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
      // Não fica "incerta": nenhuma cobrança pode existir no provedor.
      expect(failed).toMatchObject({ status: "FAILED", failureReason: "PIX_UNAVAILABLE" });
      expect(await db.auditLog.count({ where: { action: "payment.not_started", entityId: failed.id } })).toBe(1);
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PAYMENT");
    } finally {
      spy.mockRestore();
    }
    // Resolvido o problema do organizador, o comprador tenta de novo no mesmo pedido.
    const retry = await startPayment(db, adapter, customer, order.id, "PIX");
    expect(retry.providerPaymentId).toBeTruthy();
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(2);
  });

  it("PIX em criação que fica incerto: quem esperava é recusado, sem segunda cobrança", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const spy = vi.spyOn(adapter, "createPayment").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      throw new Error("timeout");
    });
    try {
      const results = await Promise.allSettled(Array.from({ length: 3 }, () => startPayment(db, adapter, customer, order.id, "PIX")));
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      const codes = results.map((r) => ((r as PromiseRejectedResult).reason as { code: string }).code).sort();
      expect(codes).toEqual(["INVALID_STATE", "INVALID_STATE", "PROVIDER_ERROR"]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({ status: "PENDING", failureReason: "PROVIDER_CREATE_UNCERTAIN" });
      // Deixa o banco consistente para a verificação de invariantes: a reserva expira.
      await db.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    } finally {
      spy.mockRestore();
    }
  });

  it("tentativas de cartão simultâneas: só uma prossegue, as demais são recusadas", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => startPayment(db, adapter, customer, order.id, "CREDIT_CARD")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "INVALID_STATE" });
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("PIX pendente bloqueia cartão; pedido pago não aceita nova tentativa", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const pix = await startPayment(db, adapter, customer, order.id, "PIX");
    await expect(startPayment(db, adapter, customer, order.id, "CREDIT_CARD", { simulatedCardOutcome: "approve" })).rejects.toThrow(/PIX gerado/);
    await handlePaymentWebhook(db, adapter, await adapter.simulate(pix.providerPaymentId!, "approve"));
    await expect(startPayment(db, adapter, customer, order.id, "PIX")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
  });
});

describe("reembolso × check-in", () => {
  it("em disputas simultâneas, nunca há entrada E reembolso do mesmo ingresso", async () => {
    const { owner, event, tt } = await setup();
    const customer = await makeUser();
    let admitted = 0;
    let refunded = 0;
    for (let i = 0; i < 8; i++) {
      const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
      const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
      const [refund, checkin] = await Promise.allSettled([
        requestCustomerRefund(db, adapter, customer, order.id),
        checkInTicket(db, owner, event.id, qrPayload(ticket)),
      ]);
      const wasRefunded = refund.status === "fulfilled" && refund.value.status === "SUCCEEDED";
      const wasAdmitted = checkin.status === "fulfilled" && checkin.value.result === "ADMITTED";
      expect(wasRefunded && wasAdmitted).toBe(false);
      expect(wasRefunded || wasAdmitted).toBe(true);
      const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      const o = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      if (wasAdmitted) expect([after.status, o.status]).toEqual(["CHECKED_IN", "PAID"]);
      else expect([after.status, o.status]).toEqual(["REVOKED", "REFUNDED"]);
      admitted += Number(wasAdmitted);
      refunded += Number(wasRefunded);
    }
    expect(admitted + refunded).toBe(8);
  });

  it("pedido de reembolso recusado (ingresso usado) devolve os ingressos ao estado válido", async () => {
    const { owner, event, tt } = await setup();
    const customer = await makeUser();
    const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: tt.id, quantity: 2 }]);
    const [t1] = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
    await checkInTicket(db, owner, event.id, qrPayload(t1));
    await expect(requestCustomerRefund(db, adapter, customer, order.id)).rejects.toThrow(/utilizados/);
    expect(await db.issuedTicket.count({ where: { orderId: order.id, status: "VALID" } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
  });
});

describe("guarda contra estorno acima do valor pago", () => {
  it("bloqueia novo pedido de reembolso, o processamento e a confirmação", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const admin = await makeUser({ admin: true });
    const { order, payment } = await buyAndPay(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);

    // Um reembolso já em andamento impede outro.
    const first = await db.refund.create({
      data: { orderId: order.id, paymentId: payment.id, amountCents: order.totalCents, reason: "ADMIN", status: "PROCESSING", idempotencyKey: `t:${randomUUID()}` },
    });
    await expect(adminRefundOrder(db, adapter, admin, order.id, "duplicado")).rejects.toThrow(/reembolso em andamento/);

    // Processar um segundo reembolso do mesmo pedido falha antes de chamar o provedor.
    const second = await db.refund.create({
      data: { orderId: order.id, paymentId: payment.id, amountCents: order.totalCents, reason: "CUSTOMER_REQUEST", idempotencyKey: `t:${randomUUID()}` },
    });
    const processed = await processRefund(db, adapter, second.id);
    expect(processed).toMatchObject({ status: "FAILED", note: expect.stringContaining("OVER_REFUND_BLOCKED") });
    expect((await db.simulatedProviderPayment.findFirstOrThrow()).state).toBe("APPROVED"); // provedor não foi acionado

    // Confirmar dois reembolsos integrais: o segundo é recusado pela última linha de defesa.
    await db.$transaction((tx) => confirmRefundTx(tx, first.id));
    await expect(db.$transaction((tx) => confirmRefundTx(tx, second.id))).rejects.toBeInstanceOf(OverRefundError);
    // Limpeza para o verificador de invariantes: o segundo nunca foi confirmado.
    expect((await db.refund.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("FAILED");
  });
});

describe("reconciliação", () => {
  it("recupera pagamento cujo webhook se perdeu", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 2 }]);
    const p = await startPayment(db, adapter, customer, order.id, "PIX");
    await adapter.simulate(p.providerPaymentId!, "approve"); // aprovado no provedor, webhook nunca entregue
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PAYMENT");

    const quiet = await reconcilePayments(db, adapter); // ainda dentro do prazo: não mexe
    expect(quiet.paymentsSynced).toBe(0);
    const report = await reconcilePayments(db, adapter, minutesFromNow(11));
    expect(report).toMatchObject({ paymentsSynced: 1, errors: [] });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(2);
    // Rodar de novo não muda nada (idempotente).
    await reconcilePayments(db, adapter, minutesFromNow(11));
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(2);
  });

  it("reprocessa webhook registrado cujo processamento falhou", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const p = await startPayment(db, adapter, customer, order.id, "PIX");
    await adapter.simulate(p.providerPaymentId!, "approve");
    const hook = await db.paymentWebhookEvent.create({
      data: {
        provider: adapter.id,
        externalEventId: `lost-${randomUUID()}`,
        eventType: "payment.updated",
        providerPaymentId: p.providerPaymentId,
        payload: {},
        receivedAt: minutesFromNow(-5),
        error: "simulated crash",
      },
    });
    const report = await reconcilePayments(db, adapter);
    expect(report.webhooksReprocessed).toBe(1);
    expect((await db.paymentWebhookEvent.findUniqueOrThrow({ where: { id: hook.id } })).processingResult).toBe("reconciled:paid");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
  });

  it("vincula pagamento criado no provedor cujo id não foi salvo; encerra o que nunca existiu", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    // Simula queda do processo: a cobrança existe no provedor, mas o id não foi gravado.
    const key = `${order.id}:PIX:1`;
    const orphan = await db.payment.create({
      data: { orderId: order.id, provider: adapter.id, method: "PIX", amountCents: order.totalCents, isSimulated: true, idempotencyKey: key },
    });
    const created = await adapter.createPayment({
      paymentId: orphan.id,
      orderId: order.id,
      amountCents: order.totalCents,
      method: "PIX",
      description: "teste",
      payer: { email: "a@b.c", name: "A" },
      expiresAt: order.expiresAt,
      idempotencyKey: key,
      marketplace: { organizationId: order.organizationId, sellerAccountId: null, applicationFeeCents: 0 },
    });
    if (!created.providerPaymentId) throw new Error("Simulated payment must return a provider ID");
    await adapter.simulate(created.providerPaymentId, "approve");

    const other = await buy(await makeUser(), event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const ghost = await db.payment.create({
      data: { orderId: other.id, provider: adapter.id, method: "PIX", amountCents: other.totalCents, isSimulated: true, idempotencyKey: `${other.id}:PIX:1` },
    });

    const report = await reconcilePayments(db, adapter, minutesFromNow(11));
    expect(report).toMatchObject({ paymentsLinked: 1, paymentsClosedNotFound: 1, errors: [] });
    expect(await db.payment.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({ providerPaymentId: created.providerPaymentId, status: "PAID" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await db.payment.findUniqueOrThrow({ where: { id: ghost.id } })).toMatchObject({ status: "FAILED", failureReason: "provider_create_not_found" });
    // O pedido sem cobrança segue o fluxo normal de expiração da reserva.
    await expireStaleOrders(db, minutesFromNow(16));
  });

  it("retoma reembolso parado em PROCESSING sem estornar duas vezes", async () => {
    const { event, tt } = await setup();
    const customer = await makeUser();
    const { order, payment } = await buyAndPay(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    // Simula queda entre "reivindicar o reembolso" e chamar o provedor.
    await db.issuedTicket.updateMany({ where: { orderId: order.id }, data: { status: "REVOKED", revocationReason: "REFUNDED", revokedAt: new Date() } });
    await db.order.update({ where: { id: order.id }, data: { status: "REFUND_PENDING" } });
    const refund = await db.refund.create({
      data: { orderId: order.id, paymentId: payment.id, amountCents: order.totalCents, reason: "CUSTOMER_REQUEST", status: "PROCESSING", idempotencyKey: `refund:${order.id}:customer_request` },
    });
    const report = await reconcilePayments(db, adapter, minutesFromNow(11));
    expect(report).toMatchObject({ refundsResumed: 1, errors: [] });
    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("SUCCEEDED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
    // Segunda passada: nada a fazer, nenhum lançamento duplicado.
    const before = await db.financialLedgerEntry.count();
    await reconcilePayments(db, adapter, minutesFromNow(11));
    expect(await db.financialLedgerEntry.count()).toBe(before);
  });
});

describe("estresse e verificador de invariantes", () => {
  it("compras, pagamentos com webhooks duplicados, cancelamentos e expirações simultâneos mantêm tudo consistente", async () => {
    const { event, tt } = await setup(10);
    const buyers = await Promise.all(Array.from({ length: 25 }, () => makeUser()));
    const outcomes = await Promise.allSettled(
      buyers.map(async (u, i) => {
        const order = await createOrder(db, u, orderInput(event.id, [{ ticketTypeId: tt.id, quantity: 1 }]), { providerIsSimulated: true });
        if (i % 3 === 0) {
          const p = await startPayment(db, adapter, u, order.id, "PIX");
          const hook = await adapter.simulate(p.providerPaymentId!, "approve");
          await Promise.all([handlePaymentWebhook(db, adapter, hook), handlePaymentWebhook(db, adapter, hook), handlePaymentWebhook(db, adapter, adapter.buildWebhook(p.providerPaymentId!))]);
        } else if (i % 3 === 1) {
          await db.$transaction(async () => undefined); // intercala
          const { cancelPendingOrder } = await import("@/server/services/orders");
          await cancelPendingOrder(db, u, order.id);
        }
        return order;
      }),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBeLessThanOrEqual(10 + 25); // vagas liberadas podem ser recompradas
    await expireStaleOrders(db, minutesFromNow(16));
    await reconcilePayments(db, adapter, minutesFromNow(16));
    const t = await ticketType(tt.id);
    expect(t.quantitySold).toBeLessThanOrEqual(t.quantityTotal);
    expect(t.quantityReserved).toBe(0);
    expect(await db.issuedTicket.count({ where: { eventId: event.id } })).toBe(t.quantitySold);
  });

  it("detecta inconsistência injetada sem corrigi-la", async () => {
    const { event, tt } = await setup(10);
    await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    await db.ticketType.update({ where: { id: tt.id }, data: { quantityReserved: { increment: 1 } } });
    const violations = await checkFinancialInvariants(db);
    expect(violations).toEqual([expect.objectContaining({ code: "RESERVED_COUNTER_MISMATCH", ids: [tt.id] })]);
    // Desfaz para o afterEach.
    await db.ticketType.update({ where: { id: tt.id }, data: { quantityReserved: { decrement: 1 } } });
  });
});
