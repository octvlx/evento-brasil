// Fluxo D: falha/expiração → liberação segura do estoque; pagamento tardio.
import { beforeEach, describe, expect, it } from "vitest";
import { expireStaleOrders } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb, ticketType } from "../support/fixtures";

beforeEach(resetDb);

const later = (min: number) => new Date(Date.now() + min * 60_000);

describe("D — expiração e liberação de estoque", () => {
  it("expira reservas vencidas e devolve o estoque (job)", async () => {
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org, { tickets: [{ priceCents: 5000, quantityTotal: 2 }] });
    const tt = event.ticketTypes[0];
    const order = await buy(await makeUser(), event.id, [{ ticketTypeId: tt.id, quantity: 2 }]);
    expect((await ticketType(tt.id)).quantityReserved).toBe(2);
    expect(await expireStaleOrders(db, later(5))).toBe(0);
    expect(await expireStaleOrders(db, later(16))).toBe(1);
    expect(await expireStaleOrders(db, later(16))).toBe(0); // idempotente
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("EXPIRED");
    expect(await ticketType(tt.id)).toMatchObject({ quantityReserved: 0, quantitySold: 0 });
    expect((await db.ticketInventoryReservation.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe("RELEASED");
  });

  it("expiração do PIX no provedor libera o estoque imediatamente", async () => {
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org, { tickets: [{ priceCents: 5000, quantityTotal: 2 }] });
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const p = await startPayment(db, adapter, customer, order.id, "PIX");
    expect((await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "expire"))).body).toBe("payment_expired");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("EXPIRED");
    expect((await ticketType(event.ticketTypes[0].id)).quantityReserved).toBe(0);
  });

  it("pagamento tardio com estoque disponível é recuperado", async () => {
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org, { tickets: [{ priceCents: 5000, quantityTotal: 5 }] });
    const customer = await makeUser();
    const order = await buy(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const p = await startPayment(db, adapter, customer, order.id, "PIX");
    await expireStaleOrders(db, later(16));
    const res = await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"));
    expect(res.body).toBe("late_paid");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(1);
    expect(await ticketType(event.ticketTypes[0].id)).toMatchObject({ quantitySold: 1, quantityReserved: 0 });
  });

  it("pagamento tardio sem estoque gera reembolso automático e nenhum ingresso", async () => {
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org, { tickets: [{ priceCents: 5000, quantityTotal: 1 }] });
    const late = await makeUser();
    const order = await buy(late, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const p = await startPayment(db, adapter, late, order.id, "PIX");
    await expireStaleOrders(db, later(16));
    // Outra pessoa compra o último ingresso.
    await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const res = await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"));
    expect(res.body).toBe("late_payment_refund");
    const refreshed = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { refunds: true } });
    expect(refreshed.status).toBe("REFUNDED");
    expect(refreshed.refunds[0]).toMatchObject({ reason: "LATE_PAYMENT_NO_INVENTORY", status: "SUCCEEDED" });
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(0);
    expect(await ticketType(event.ticketTypes[0].id)).toMatchObject({ quantitySold: 1, quantityReserved: 0 });
    const entries = await db.financialLedgerEntry.findMany({ where: { orderId: order.id } });
    const net = entries.reduce((s, e) => s + (e.account === "CUSTOMER_FUNDS" ? (e.direction === "DEBIT" ? e.amountCents : -e.amountCents) : 0), 0);
    expect(net).toBe(0);
  });
});
