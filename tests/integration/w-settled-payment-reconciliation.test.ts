import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPaymentSnapshot } from "@/server/services/payments";
import { reconcilePayments } from "@/server/services/reconciliation";
import { checkInTicket } from "@/server/services/checkin";
import { qrPayload } from "@/server/services/tickets";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
const future = (minutes: number) => new Date(Date.now() + minutes * 60_000);

async function paidOrder() {
  const owner = await makeUser();
  const event = await makeEvent(await makeOrg(owner));
  const buyer = await makeUser();
  const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
  return { owner, event, order, payment, ticket };
}

describe("reconciliação de pagamentos já confirmados", () => {
  it.each(["REFUNDED", "CHARGED_BACK"] as const)("recupera %s sem receber webhook, revoga ingresso e não repete o estorno", async (state) => {
    const { owner, event, order, payment, ticket } = await paidOrder();
    await db.simulatedProviderPayment.update({ where: { id: payment.providerPaymentId! }, data: { state } });
    const result = await reconcilePayments(db, adapter, future(11));
    expect(result).toMatchObject({ settledPaymentsSynced: 1, errors: [] });
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: state });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: state === "REFUNDED" ? "REFUNDED" : "DISPUTED" });
    expect(await checkInTicket(db, owner, event.id, qrPayload(ticket))).toMatchObject({ result: "REVOKED" });
    const ledger = await db.financialLedgerEntry.findMany({ where: { orderId: order.id } });
    const counters = await db.ticketType.findUniqueOrThrow({ where: { id: ticket.ticketTypeId } });
    const refundCount = await db.refund.count({ where: { orderId: order.id } });
    expect(ledger.some((entry) => entry.type === (state === "REFUNDED" ? "REFUND" : "CHARGEBACK"))).toBe(true);
    expect(await reconcilePayments(db, adapter, future(22))).toMatchObject({ settledPaymentsSynced: 0, errors: [] });
    expect(await db.financialLedgerEntry.findMany({ where: { orderId: order.id } })).toEqual(ledger);
    expect(await db.ticketType.findUniqueOrThrow({ where: { id: ticket.ticketTypeId } })).toEqual(counters);
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(refundCount);
  });

  it("recupera resolução de disputa sem webhook e sem duplicar a venda", async () => {
    const { order, payment } = await paidOrder();
    const snapshot = await adapter.getPayment(payment.providerPaymentId!);
    await applyPaymentSnapshot(db, adapter, { ...snapshot, status: "DISPUTED" });
    const before = await db.financialLedgerEntry.count({ where: { orderId: order.id } });
    expect(await reconcilePayments(db, adapter, future(11))).toMatchObject({ settledPaymentsSynced: 1, errors: [] });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID" });
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: "PAID" });
    expect(await db.financialLedgerEntry.count({ where: { orderId: order.id } })).toBe(before);
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("limite de lote não deixa pagamentos posteriores sem consulta", async () => {
    const a = await paidOrder();
    const b = await paidOrder();
    await db.payment.update({ where: { id: a.payment.id }, data: { updatedAt: new Date(1000) } });
    await db.payment.update({ where: { id: b.payment.id }, data: { updatedAt: new Date(2000) } });
    await adapter.simulate(b.payment.providerPaymentId!, "chargeback");
    const now = future(11);
    await reconcilePayments(db, adapter, now, { limit: 1 });
    expect(await db.payment.findUniqueOrThrow({ where: { id: b.payment.id } })).toMatchObject({ status: "PAID" });
    await reconcilePayments(db, adapter, now, { limit: 1 });
    expect(await db.payment.findUniqueOrThrow({ where: { id: b.payment.id } })).toMatchObject({ status: "CHARGED_BACK" });
  });

  it("erro do provedor preserva o pagamento e permite processar o próximo lote", async () => {
    const a = await paidOrder();
    const b = await paidOrder();
    await db.payment.update({ where: { id: a.payment.id }, data: { updatedAt: new Date(1000) } });
    await db.payment.update({ where: { id: b.payment.id }, data: { updatedAt: new Date(2000) } });
    await adapter.simulate(b.payment.providerPaymentId!, "chargeback");
    const spy = vi.spyOn(adapter, "getPayment").mockRejectedValueOnce(new Error("provider unavailable"));
    try {
      const now = future(11);
      const report = await reconcilePayments(db, adapter, now, { limit: 1 });
      expect(report.settledPaymentsSynced).toBe(0);
      expect(report.errors).toMatchObject([{ kind: "settled-payment", id: a.payment.id }]);
      expect(await db.payment.findUniqueOrThrow({ where: { id: a.payment.id } })).toMatchObject({ status: "PAID" });
      await reconcilePayments(db, adapter, now, { limit: 1 });
      expect(await db.payment.findUniqueOrThrow({ where: { id: b.payment.id } })).toMatchObject({ status: "CHARGED_BACK" });
      expect(await reconcilePayments(db, adapter, future(22), { limit: 1 })).toMatchObject({ settledPaymentsSynced: 1, errors: [] });
    } finally {
      spy.mockRestore();
    }
  });
});
