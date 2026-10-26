// Fluxos G e H: reembolso confirmado → ingresso revogado → razão atualizado;
// cancelamento do evento → pedidos afetados → reembolsos.
import { beforeEach, describe, expect, it } from "vitest";
import { cancelEvent } from "@/server/services/cancellation";
import { checkInTicket } from "@/server/services/checkin";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { requestCustomerRefund } from "@/server/services/refunds";
import { organizerFinancials, organizerOverview } from "@/server/services/reports";
import { qrPayload } from "@/server/services/tickets";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb, ticketType } from "../support/fixtures";

beforeEach(resetDb);

describe("G — reembolso", () => {
  it("revoga ingressos, estorna o razão e invalida o QR", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 10 }] });
    const customer = await makeUser();
    const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });

    const intruder = await makeUser();
    await expect(requestCustomerRefund(db, adapter, intruder, order.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const refund = await requestCustomerRefund(db, adapter, customer, order.id);
    expect(refund).toMatchObject({ status: "SUCCEEDED", amountCents: 20000, reason: "CUSTOMER_REQUEST" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
    expect(await db.issuedTicket.count({ where: { orderId: order.id, status: "REVOKED", revocationReason: "REFUNDED" } })).toBe(2);
    expect(await ticketType(event.ticketTypes[0].id)).toMatchObject({ quantitySold: 2, quantityRefunded: 2 });
    expect((await checkInTicket(db, owner, event.id, qrPayload(ticket))).result).toBe("REVOKED");

    // Repetir não duplica nada.
    await expect(requestCustomerRefund(db, adapter, customer, order.id)).rejects.toThrow();
    expect(await db.refund.count()).toBe(1);

    const fin = await organizerFinancials(db, owner, org.id);
    expect(fin).toMatchObject({ grossCents: 20000, refundCents: 20000, platformFeeCents: 0, organizerNetCents: 0, includesSimulated: true });
    expect((await organizerOverview(db, owner, org.id)).ticketsSold).toBe(0);
  });

  it("recusa reembolso de pedido com ingresso já utilizado", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org);
    const customer = await makeUser();
    const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const t = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
    await checkInTicket(db, owner, event.id, qrPayload(t));
    await expect(requestCustomerRefund(db, adapter, customer, order.id)).rejects.toThrow(/utilizados/);
  });

  it("o razão financeiro é imutável", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org);
    await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const entry = await db.financialLedgerEntry.findFirstOrThrow();
    await expect(db.financialLedgerEntry.update({ where: { id: entry.id }, data: { amountCents: 1 } })).rejects.toThrow();
    await expect(db.financialLedgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow();
  });
});

describe("H — cancelamento do evento", () => {
  it("libera pendentes, revoga ingressos e reembolsa pedidos pagos", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org, { tickets: [{ priceCents: 8000, quantityTotal: 20 }] });
    const tt = event.ticketTypes[0];
    const paid1 = await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: tt.id, quantity: 2 }]);
    const paid2 = await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    const pendingBuyer = await makeUser();
    const pending = await buy(pendingBuyer, event.id, [{ ticketTypeId: tt.id, quantity: 3 }]);
    const pendingPayment = await startPayment(db, adapter, pendingBuyer, pending.id, "PIX");

    const stranger = await makeUser();
    await expect(cancelEvent(db, adapter, stranger, event.id, "Chuva")).rejects.toMatchObject({ code: "FORBIDDEN" });

    const result = await cancelEvent(db, adapter, owner, event.id, "Problema com o local");
    expect(result).toMatchObject({ pendingReleased: 1 });
    expect(result.refundIds).toHaveLength(2);

    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("CANCELLED");
    expect((await db.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("CANCELLED");
    for (const { order } of [paid1, paid2]) {
      const o = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { refunds: true } });
      expect(o.status).toBe("REFUNDED");
      expect(o.refunds[0]).toMatchObject({ reason: "EVENT_CANCELLED", status: "SUCCEEDED" });
    }
    expect(await db.issuedTicket.count({ where: { eventId: event.id, status: { not: "REVOKED" } } })).toBe(0);
    expect(await ticketType(tt.id)).toMatchObject({ quantityReserved: 0, quantitySold: 3, quantityRefunded: 3 });

    // Pagamento do pedido pendente chegando depois: o evento está cancelado → reembolso, sem ingressos.
    const late = await handlePaymentWebhook(db, adapter, await adapter.simulate(pendingPayment.providerPaymentId!, "approve"));
    expect(late.body).toBe("late_payment_refund");
    expect(await db.issuedTicket.count({ where: { orderId: pending.id } })).toBe(0);

    // Cancelar de novo é recusado.
    await expect(cancelEvent(db, adapter, owner, event.id, "de novo")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
