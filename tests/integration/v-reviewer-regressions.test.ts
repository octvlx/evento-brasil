import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkInTicket, checkinHistory } from "@/server/services/checkin";
import { createOrder } from "@/server/services/orders";
import { applyPaymentSnapshot, startPayment } from "@/server/services/payments";
import { reconcilePayments } from "@/server/services/reconciliation";
import { qrPayload } from "@/server/services/tickets";
import { MercadoPagoAdapter } from "@/server/payments/mercadopago";
import type { PaymentProviderAdapter } from "@/server/payments/types";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup(priceCents = 10000) {
  const owner = await makeUser();
  const staff = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: staff.id, role: "CHECKIN_STAFF" }] });
  const event = await makeEvent(org, { tickets: [{ priceCents, quantityTotal: 20 }] });
  const buyer = await makeUser();
  const items = [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }];
  return { owner, staff, org, event, buyer, items };
}

describe("regressões da revisão independente", () => {
  it.each(["PIX", "CREDIT_CARD"] as const)("%s: timeout após cobrança bloqueia repetição e reconcilia a mesma tentativa", async (method) => {
    const { event, buyer, items } = await setup();
    const order = await buy(buyer, event.id, items);
    const create = adapter.createPayment.bind(adapter);
    const spy = vi.spyOn(adapter, "createPayment").mockImplementationOnce(async (input) => {
      await create(input);
      throw new Error("resposta perdida após criação");
    });
    try {
      await expect(startPayment(db, adapter, buyer, order.id, method)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
      const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
      expect(payment).toMatchObject({ status: "PENDING", providerPaymentId: null, failureReason: "PROVIDER_CREATE_UNCERTAIN" });
      await expect(startPayment(db, adapter, buyer, order.id, method)).rejects.toMatchObject({ code: "INVALID_STATE" });
      await expect(startPayment(db, adapter, buyer, order.id, method === "PIX" ? "CREDIT_CARD" : "PIX")).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
      const remote = await db.simulatedProviderPayment.findFirstOrThrow({ where: { externalRef: payment.idempotencyKey } });
      await adapter.simulate(remote.id, "approve");
      const report = await reconcilePayments(db, adapter, new Date(Date.now() + 11 * 60_000));
      expect(report).toMatchObject({ paymentsLinked: 1, errors: [] });
      expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: "PAID", providerPaymentId: remote.id });
      expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("só libera nova tentativa após o provedor confirmar ausência da cobrança", async () => {
    const { event, buyer, items } = await setup();
    const order = await buy(buyer, event.id, items);
    const spy = vi.spyOn(adapter, "createPayment").mockRejectedValueOnce(new Error("rede indisponível"));
    try {
      await expect(startPayment(db, adapter, buyer, order.id, "PIX")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    } finally {
      spy.mockRestore();
    }
    await reconcilePayments(db, adapter, new Date(Date.now() + 11 * 60_000));
    expect(await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({ status: "FAILED", failureReason: "provider_create_not_found" });
    await startPayment(db, adapter, buyer, order.id, "PIX");
    expect(await db.simulatedProviderPayment.count()).toBe(1);
  });

  it("sem consulta por referência, mantém a cobrança incerta bloqueada para revisão manual", async () => {
    const { event, buyer, items } = await setup();
    const order = await buy(buyer, event.id, items);
    const noLookup: PaymentProviderAdapter = Object.create(adapter);
    noLookup.findPaymentByReference = undefined;
    const spy = vi.spyOn(noLookup, "createPayment").mockRejectedValueOnce(new Error("timeout"));
    try {
      await expect(startPayment(db, noLookup, buyer, order.id, "PIX")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
      const report = await reconcilePayments(db, noLookup, new Date(Date.now() + 11 * 60_000));
      expect(report).toMatchObject({ paymentsNeedReview: 1, paymentsClosedNotFound: 0 });
      await expect(startPayment(db, noLookup, buyer, order.id, "PIX")).rejects.toMatchObject({ code: "INVALID_STATE" });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("resolve disputa sem duplicar ingressos, estoque ou lançamentos e preserva pedido em reembolso", async () => {
    const { event, buyer, items } = await setup();
    const { order, payment } = await buyAndPay(buyer, event.id, items);
    const snapshot = await adapter.getPayment(payment.providerPaymentId!);
    const paidOrder = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id } });
    const ledger = await db.financialLedgerEntry.count({ where: { orderId: order.id } });
    expect(await applyPaymentSnapshot(db, adapter, { ...snapshot, status: "DISPUTED" })).toBe("disputed");
    expect(await applyPaymentSnapshot(db, adapter, snapshot)).toBe("dispute_resolved");
    expect(await applyPaymentSnapshot(db, adapter, snapshot)).toBe("already_processed");
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID", paidAt: paidOrder.paidAt });
    expect(await db.issuedTicket.findMany({ where: { orderId: order.id } })).toEqual(tickets);
    expect(await db.financialLedgerEntry.count({ where: { orderId: order.id } })).toBe(ledger);
    expect(await db.ticketType.findUniqueOrThrow({ where: { id: items[0].ticketTypeId } })).toMatchObject({ quantitySold: 1, quantityReserved: 0 });
    await applyPaymentSnapshot(db, adapter, { ...snapshot, status: "DISPUTED" });
    await db.order.update({ where: { id: order.id }, data: { status: "REFUND_PENDING" } });
    await applyPaymentSnapshot(db, adapter, snapshot);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "REFUND_PENDING" });
  });

  it("snapshot de disputa não reabre pagamento estornado", async () => {
    const { event, buyer, items } = await setup();
    const { payment } = await buyAndPay(buyer, event.id, items);
    const snapshot = await adapter.getPayment(payment.providerPaymentId!);
    await applyPaymentSnapshot(db, adapter, { ...snapshot, status: "REFUNDED" });
    expect(await applyPaymentSnapshot(db, adapter, { ...snapshot, status: "DISPUTED" })).toBe("no_change");
    expect(await applyPaymentSnapshot(db, adapter, snapshot)).toBe("no_change");
  });

  it("suspensão da organização impede leitura e histórico tanto do dono quanto da equipe atribuída", async () => {
    const { owner, staff, org, event, buyer, items } = await setup();
    const { order } = await buyAndPay(buyer, event.id, items);
    await db.eventStaffAssignment.create({ data: { eventId: event.id, userId: staff.id, assignedById: owner.id } });
    const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
    await db.organization.update({ where: { id: org.id }, data: { status: "SUSPENDED" } });
    for (const actor of [owner, staff]) {
      await expect(checkInTicket(db, actor, event.id, qrPayload(ticket))).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(checkinHistory(db, actor, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await db.ticketCheckin.count()).toBe(0);
    expect(await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ status: "VALID" });
  });

  it("adaptador indisponível não anuncia métodos nem reserva pedido pago; gratuito continua funcionando", async () => {
    const { event, buyer, items } = await setup();
    const disabled = new MercadoPagoAdapter(undefined);
    expect(disabled.supportedMethods).toEqual([]);
    await expect(startPayment(db, disabled, buyer, "unused-order", "PIX")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createOrder(db, buyer, orderInput(event.id, items), { providerIsSimulated: false, paymentsAvailable: false })).rejects.toMatchObject({ code: "SALES_CLOSED" });
    expect(await db.order.count()).toBe(0);
    expect(await db.ticketInventoryReservation.count()).toBe(0);
    const free = await setup(0);
    const order = await createOrder(db, free.buyer, orderInput(free.event.id, free.items), { providerIsSimulated: false, paymentsAvailable: false });
    expect(order.status).toBe("PAID");
  });

  it("cancelamento exige o mesmo evento e organização do pedido", async () => {
    const { org, event, buyer, items } = await setup();
    const order = await buy(buyer, event.id, items);
    const sameOrgEvent = await makeEvent(org);
    const otherOrg = await makeOrg(await makeUser());
    const otherEvent = await makeEvent(otherOrg);
    const request = (eventId: string, organizationId: string) => db.cancellationRequest.create({ data: {
      protocol: "CAN-20261027-7KQ2M9", orderId: order.id, eventId, organizationId, requestedById: buyer.id, reason: "Cancelar compra",
    } });
    await expect(request(sameOrgEvent.id, org.id)).rejects.toThrow(/CancellationRequest_orderId_eventId_organizationId_fkey/);
    await expect(request(otherEvent.id, otherOrg.id)).rejects.toThrow(/CancellationRequest_orderId_eventId_organizationId_fkey/);
    expect(await request(event.id, org.id)).toMatchObject({ orderId: order.id, eventId: event.id, organizationId: org.id });
  });
});
