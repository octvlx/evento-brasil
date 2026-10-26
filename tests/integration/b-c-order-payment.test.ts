// Fluxos B e C: seleção → reserva → pedido → checkout; webhook verificado →
// atualização idempotente → emissão única de ingressos.
import { beforeEach, describe, expect, it } from "vitest";
import { createOrder } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeUser, orderInput, resetDb, ticketType } from "../support/fixtures";

beforeEach(resetDb);

async function setup(tickets = [{ priceCents: 10000, quantityTotal: 50 }]) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets });
  const customer = await makeUser();
  return { owner, org, event, customer };
}

describe("B — reserva e pedido", () => {
  it("reserva estoque, usa preços do banco e calcula comissão de 7%", async () => {
    const { event, customer } = await setup();
    const tt = event.ticketTypes[0];
    const order = await createOrder(db, customer, { ...orderInput(event.id, [{ ticketTypeId: tt.id, quantity: 2 }]), priceCents: 1 } as never, { providerIsSimulated: true });
    expect(order).toMatchObject({ status: "PENDING_PAYMENT", subtotalCents: 20000, serviceFeeCents: 0, totalCents: 20000, commissionCents: 1400, isSimulated: true });
    expect(order.feePolicyVersion).toBe("platform:default:v1");
    expect(await ticketType(tt.id)).toMatchObject({ quantityReserved: 2, quantitySold: 0 });
    const reservation = await db.ticketInventoryReservation.findFirstOrThrow({ where: { orderId: order.id } });
    expect(reservation.status).toBe("ACTIVE");
    expect(reservation.expiresAt.getTime() - order.createdAt.getTime()).toBeGreaterThan(14 * 60_000);
  });

  it("é idempotente pela chave do cliente", async () => {
    const { event, customer } = await setup();
    const input = orderInput(event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const [a, b] = await Promise.all([
      createOrder(db, customer, input, { providerIsSimulated: true }),
      createOrder(db, customer, input, { providerIsSimulated: true }),
    ]);
    expect(a.id).toBe(b.id);
    expect((await ticketType(event.ticketTypes[0].id)).quantityReserved).toBe(1);
  });

  it("respeita limites por pedido, janela de venda e cota de meia-entrada", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org, {
      capacity: 10,
      halfPriceQuotaBps: 4000, // 4 de 10
      tickets: [
        { priceCents: 10000, quantityTotal: 10, maxPerOrder: 3 },
        { priceCents: 5000, quantityTotal: 10, kind: "HALF_PRICE", maxPerOrder: 5 },
      ],
    });
    const [full, half] = event.ticketTypes;
    const c = await makeUser();
    await expect(buy(c, event.id, [{ ticketTypeId: full.id, quantity: 4 }])).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(buy(c, event.id, [{ ticketTypeId: half.id, quantity: 1 }])).rejects.toThrow(/declaração/);
    const ok = await createOrder(db, c, orderInput(event.id, [{ ticketTypeId: half.id, quantity: 4 }], { halfPriceDeclaration: true }), { providerIsSimulated: true });
    expect(ok.totalCents).toBe(20000);
    const c2 = await makeUser();
    await expect(
      createOrder(db, c2, orderInput(event.id, [{ ticketTypeId: half.id, quantity: 1 }], { halfPriceDeclaration: true }), { providerIsSimulated: true }),
    ).rejects.toThrow(/Cota de meia-entrada/);
  });

  it("checkout inicia PIX pendente sem marcar como pago", async () => {
    const { event, customer } = await setup();
    const order = await buy(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const payment = await startPayment(db, adapter, customer, order.id, "PIX");
    expect(payment.status).toBe("PENDING");
    expect(payment.pixCopyPaste).toMatch(/^SIMULADO-NAO-PAGUE/);
    // Reaproveita o mesmo PIX.
    expect((await startPayment(db, adapter, customer, order.id, "PIX")).id).toBe(payment.id);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PAYMENT");
    expect(await db.issuedTicket.count()).toBe(0);
    const other = await makeUser();
    await expect(startPayment(db, adapter, other, order.id, "PIX")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("pedido gratuito emite ingressos sem pagamento e sem comissão", async () => {
    const { event, customer } = await setup([{ priceCents: 0, quantityTotal: 5 }]);
    const order = await buy(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    expect(order).toMatchObject({ status: "PAID", totalCents: 0, commissionCents: 0, isSimulated: false });
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(2);
    expect(await ticketType(event.ticketTypes[0].id)).toMatchObject({ quantitySold: 2, quantityReserved: 0 });
  });
});

describe("C — webhook verificado → confirmação idempotente → emissão", () => {
  it("emite ingressos uma única vez, mesmo com reentregas e concorrência", async () => {
    const { event, customer } = await setup();
    const tt = event.ticketTypes[0];
    const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 3 }]);
    const payment = await startPayment(db, adapter, customer, order.id, "PIX");
    const hook = await adapter.simulate(payment.providerPaymentId!, "approve");

    // Mesmo evento entregue 5x em paralelo + novos eventos para o mesmo pagamento.
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => handlePaymentWebhook(db, adapter, hook)),
      ...Array.from({ length: 3 }, () => handlePaymentWebhook(db, adapter, adapter.buildWebhook(payment.providerPaymentId!))),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body === "paid")).toHaveLength(1);

    const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id } });
    expect(tickets).toHaveLength(3);
    expect(new Set(tickets.map((t) => t.validationToken)).size).toBe(3);
    expect(tickets.every((t) => t.validationToken.length === 43 && t.status === "VALID")).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await ticketType(tt.id)).toMatchObject({ quantityReserved: 0, quantitySold: 3 });

    const ledger = await db.financialLedgerEntry.findMany({ where: { orderId: order.id } });
    const sum = (d: string) => ledger.filter((e) => e.direction === d).reduce((s, e) => s + e.amountCents, 0);
    expect(sum("DEBIT")).toBe(30000);
    expect(sum("CREDIT")).toBe(30000);
    expect(ledger.find((e) => e.account === "PLATFORM_COMMISSION")?.amountCents).toBe(2100);
    expect(ledger.find((e) => e.account === "ORGANIZER_PAYABLE")?.amountCents).toBe(27900);
    expect(await db.paymentWebhookEvent.count()).toBe(4);
  });

  it("rejeita assinatura inválida e não confia no corpo do webhook", async () => {
    const { event, customer } = await setup();
    const order = await buy(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const payment = await startPayment(db, adapter, customer, order.id, "PIX");
    const hook = adapter.buildWebhook(payment.providerPaymentId!);
    const tampered = { ...hook, rawBody: hook.rawBody.replace("payment.updated", "payment.approved") };
    expect((await handlePaymentWebhook(db, adapter, tampered)).status).toBe(401);
    // Webhook válido, mas o provedor ainda diz PENDENTE: nada é emitido.
    expect((await handlePaymentWebhook(db, adapter, hook)).body).toBe("no_change");
    expect(await db.issuedTicket.count()).toBe(0);
  });

  it("cartão recusado não emite ingresso e mantém a reserva para nova tentativa", async () => {
    const { event, customer } = await setup();
    const order = await buy(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const p = await startPayment(db, adapter, customer, order.id, "CREDIT_CARD", { simulatedCardOutcome: "decline" });
    expect(p.status).toBe("FAILED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING_PAYMENT");
    const p2 = await startPayment(db, adapter, customer, order.id, "CREDIT_CARD", { simulatedCardOutcome: "approve" });
    expect(p2.status).toBe("PAID");
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("pedidos pagos geram QR válidos (fluxo completo)", async () => {
    const { event, customer } = await setup();
    const { order, webhook } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    expect(webhook).toEqual({ status: 200, body: "paid" });
    const t = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
    expect(t.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
  });
});
