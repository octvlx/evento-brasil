// Reembolso parcial por ingresso: valor com a taxa de serviço, pedido continua pago,
// último ingresso fecha o pedido, ingresso usado, falha e restauração, retentativa,
// cancelamento do evento depois de um parcial e relatório de vendas.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { PaymentProviderAdapter } from "@/server/payments/types";
import { cancelEvent } from "@/server/services/cancellation";
import { checkInTicket } from "@/server/services/checkin";
import { handlePaymentWebhook } from "@/server/services/payments";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { adminRefundOrder, adminRestoreAfterFailedRefund, listFailedRefunds, requestCustomerRefund, retryFailedRefunds } from "@/server/services/refunds";
import { organizerFinancials, salesReport } from "@/server/services/reports";
import { qrPayload } from "@/server/services/tickets";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb, ticketType } from "../support/fixtures";

beforeEach(resetDb);

/** Evento com taxa de serviço paga pelo comprador (10%) e dois tipos de ingresso. */
async function setup(opts: { refundCommissionOnRefund?: boolean } = {}) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 20 }, { priceCents: 5000, quantityTotal: 20 }] });
  await db.commissionRule.create({
    data: { scope: "EVENT", eventId: event.id, percentBps: 1000, bearer: "BUYER", refundCommissionOnRefund: opts.refundCommissionOnRefund ?? true, policyVersion: `test:${randomUUID()}` },
  });
  const buyer = await makeUser();
  const [full, half] = event.ticketTypes;
  const { order, payment } = await buyAndPay(buyer, event.id, [
    { ticketTypeId: full.id, quantity: 2 },
    { ticketTypeId: half.id, quantity: 1 },
  ]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, include: { orderItem: true }, orderBy: [{ orderItemId: "asc" }, { sequence: "asc" }] });
  const price = (t: (typeof tickets)[number]) => t.orderItem.unitPriceCents + t.orderItem.serviceFeePerUnitCents;
  return { owner, org, event, buyer, order, payment, tickets, price };
}

const orderOf = (id: string) => db.order.findUniqueOrThrow({ where: { id }, include: { payments: true } });
const failing = (): PaymentProviderAdapter => {
  const a = Object.create(adapter) as PaymentProviderAdapter;
  a.refundPayment = async () => ({ providerRefundId: "sim-falha", status: "FAILED" });
  return a;
};

describe("reembolso parcial", () => {
  it("devolve preço + taxa do ingresso escolhido; o pedido segue pago com os demais válidos", async () => {
    const { owner, org, buyer, order, tickets, price, event } = await setup();
    const target = tickets.find((t) => t.ticketTypeId === event.ticketTypes[1].id)!;
    expect(target.orderItem.serviceFeePerUnitCents).toBeGreaterThan(0);

    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [target.id]);
    expect(refund).toMatchObject({ status: "SUCCEEDED", partial: true, amountCents: price(target) });

    const after = await orderOf(order.id);
    expect(after.status).toBe("PAID");
    expect(after.payments[0].status).toBe("PAID");
    const states = await db.issuedTicket.findMany({ where: { orderId: order.id }, select: { id: true, status: true, refundId: true } });
    expect(states.filter((t) => t.status === "VALID")).toHaveLength(2);
    expect(states.find((t) => t.id === target.id)).toMatchObject({ status: "REVOKED", refundId: refund.id });
    expect(await ticketType(target.ticketTypeId)).toMatchObject({ quantitySold: 1, quantityRefunded: 1 });

    const sim = await db.simulatedProviderPayment.findFirstOrThrow({ where: { id: after.payments[0].providerPaymentId! } });
    expect(sim).toMatchObject({ state: "APPROVED", refundedCents: price(target) });

    const fin = await organizerFinancials(db, owner, org.id);
    expect(fin.refundCents).toBe(price(target));
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("o último ingresso fecha o pedido e o pagamento como reembolsados", async () => {
    const { owner, org, buyer, order, tickets, price } = await setup();
    await requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[0].id]);
    await requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[1].id]);
    expect((await orderOf(order.id)).status).toBe("PAID");
    // Os que restam viram o reembolso integral do restante.
    const last = await requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[2].id]);
    expect(last).toMatchObject({ status: "SUCCEEDED", partial: false, amountCents: price(tickets[2]) });

    const after = await orderOf(order.id);
    expect(after.status).toBe("REFUNDED");
    expect(after.payments[0].status).toBe("REFUNDED");
    const refunds = await db.refund.findMany({ where: { orderId: order.id, status: "SUCCEEDED" } });
    expect(refunds.reduce((s, r) => s + r.amountCents, 0)).toBe(order.totalCents);
    const fin = await organizerFinancials(db, owner, org.id);
    expect(fin).toMatchObject({ grossCents: order.totalCents, refundCents: order.totalCents, platformFeeCents: 0, organizerNetCents: 0 });
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("ingresso usado fica de fora: os outros podem ser reembolsados, ele não", async () => {
    const { owner, buyer, order, tickets, event } = await setup();
    await checkInTicket(db, owner, event.id, qrPayload(tickets[0]));
    await expect(requestCustomerRefund(db, adapter, buyer, order.id)).rejects.toThrow(/utilizados/);
    await expect(requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[0].id])).rejects.toThrow(/utilizado/);
    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[1].id, tickets[2].id]);
    // Cobre todos os não usados, mas o usado continua no pedido: segue parcial.
    expect(refund.partial).toBe(true);
    expect((await orderOf(order.id)).status).toBe("PAID");
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } })).status).toBe("CHECKED_IN");
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("recusa ingresso de outro pedido, repetido e reembolso em andamento", async () => {
    const { buyer, order, tickets, event } = await setup();
    const other = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const foreign = await db.issuedTicket.findFirstOrThrow({ where: { orderId: other.order.id } });
    await expect(requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [foreign.id])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [])).rejects.toMatchObject({ code: "VALIDATION" });

    const pending = await requestCustomerRefund(db, failing(), buyer, order.id, new Date(), [tickets[0].id]);
    expect(pending.status).toBe("FAILED");
    await expect(requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[1].id])).rejects.toThrow(/andamento/);
    await expect(requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[0].id])).rejects.toThrow();
  });

  it("dois pedidos de reembolso parcial ao mesmo tempo: um passa, o outro é recusado", async () => {
    const { buyer, order, tickets } = await setup();
    const results = await Promise.allSettled([
      requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[0].id]),
      requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[0].id]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("falha entra na fila do admin, é reprocessada e pode ser desfeita sem tocar no parcial já concluído", async () => {
    const { buyer, order, tickets } = await setup();
    const admin = await makeUser({ admin: true });
    const done = await requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[0].id]);

    const failed = await requestCustomerRefund(db, failing(), buyer, order.id, new Date(), [tickets[1].id]);
    expect(failed.status).toBe("FAILED");
    const queue = await listFailedRefunds(db, admin);
    expect(queue).toEqual([expect.objectContaining({ refundId: failed.id, partial: true })]);

    // Restaurar: o provedor não estornou este valor, então os ingressos deste reembolso voltam.
    const restored = await adminRestoreAfterFailedRefund(db, adapter, admin, failed.id, "Comprador desistiu");
    expect(restored).toEqual({ outcome: "RESTORED", restoredTickets: 1 });
    expect(await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[1].id } })).toMatchObject({ status: "VALID", refundId: null });
    expect(await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } })).toMatchObject({ status: "REVOKED", refundId: done.id });
    expect((await orderOf(order.id)).status).toBe("PAID");

    // Nova falha, agora reprocessada pela manutenção.
    const again = await requestCustomerRefund(db, failing(), buyer, order.id, new Date(), [tickets[1].id]);
    const report = await retryFailedRefunds(db, adapter, new Date(Date.now() + 3_600_000));
    expect(report).toMatchObject({ retried: 1, succeeded: 1 });
    expect((await db.refund.findUniqueOrThrow({ where: { id: again.id } })).status).toBe("SUCCEEDED");
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("restaurar confere o total estornado no provedor: se o estorno aconteceu, confirma", async () => {
    const { buyer, order, tickets, price } = await setup();
    const admin = await makeUser({ admin: true });
    const failed = await requestCustomerRefund(db, failing(), buyer, order.id, new Date(), [tickets[0].id]);
    // O provedor estornou, mas a resposta se perdeu.
    const payment = (await orderOf(order.id)).payments[0];
    await db.simulatedProviderPayment.update({ where: { id: payment.providerPaymentId! }, data: { refundedCents: price(tickets[0]) } });
    const result = await adminRestoreAfterFailedRefund(db, adapter, admin, failed.id, "Conferência");
    expect(result.outcome).toBe("ALREADY_REFUNDED");
    expect((await db.refund.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("SUCCEEDED");
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } })).status).toBe("REVOKED");
  });

  it("admin reembolsa parte do pedido; comissão retida quando a regra manda", async () => {
    const { owner, org, order, tickets, price } = await setup({ refundCommissionOnRefund: false });
    const admin = await makeUser({ admin: true });
    await expect(adminRefundOrder(db, adapter, admin, order.id, "", [tickets[0].id])).rejects.toMatchObject({ code: "VALIDATION" });
    const refund = await adminRefundOrder(db, adapter, admin, order.id, "Ingresso duplicado", [tickets[0].id]);
    expect(refund).toMatchObject({ status: "SUCCEEDED", partial: true, reason: "ADMIN", amountCents: price(tickets[0]) });
    const entries = await db.financialLedgerEntry.findMany({ where: { refundId: refund.id } });
    expect(entries.find((e) => e.account === "ORGANIZER_PAYABLE")).toMatchObject({ direction: "DEBIT", amountCents: price(tickets[0]) });
    expect(entries.some((e) => e.account === "PLATFORM_COMMISSION")).toBe(false);
    expect((await organizerFinancials(db, owner, org.id)).refundCents).toBe(price(tickets[0]));
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("cancelar o evento depois de um parcial reembolsa só o restante", async () => {
    const { owner, buyer, order, tickets, price, event } = await setup();
    await requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[0].id]);
    await cancelEvent(db, adapter, owner, event.id, "Chuva forte");
    const refunds = await db.refund.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(refunds.map((r) => [r.reason, r.status, r.amountCents])).toEqual([
      ["CUSTOMER_REQUEST", "SUCCEEDED", price(tickets[0])],
      ["EVENT_CANCELLED", "SUCCEEDED", order.totalCents - price(tickets[0])],
    ]);
    expect((await orderOf(order.id)).status).toBe("REFUNDED");
    expect(await db.issuedTicket.count({ where: { orderId: order.id, refundId: refunds[1].id } })).toBe(2);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("chargeback depois de um parcial estorna só o restante no razão", async () => {
    const { owner, org, buyer, order, tickets, price, payment } = await setup();
    await requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[0].id]);
    await handlePaymentWebhook(db, adapter, await adapter.simulate(payment.providerPaymentId!, "chargeback"));
    expect((await orderOf(order.id)).status).toBe("DISPUTED");
    const charged = await db.financialLedgerEntry.findFirstOrThrow({ where: { orderId: order.id, type: "CHARGEBACK", account: "CUSTOMER_FUNDS" } });
    expect(charged.amountCents).toBe(order.totalCents - price(tickets[0]));
    expect((await organizerFinancials(db, owner, org.id)).refundCents).toBe(price(tickets[0]));
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("o relatório de vendas conta o valor e os ingressos do reembolso parcial", async () => {
    const { owner, org, buyer, order, tickets, price, event } = await setup();
    await requestCustomerRefund(db, adapter, buyer, order.id, new Date(), [tickets[0].id]);
    const report = await salesReport(db, owner, org.id, { period: { from: null, to: null } });
    expect(report.totals).toMatchObject({ orders: 1, tickets: 3, refundedOrders: 1, refundedCents: price(tickets[0]) });
    const full = report.byTicketType.find((t) => t.ticketTypeId === event.ticketTypes[0].id)!;
    const half = report.byTicketType.find((t) => t.ticketTypeId === event.ticketTypes[1].id)!;
    expect([full.refundedTickets, half.refundedTickets]).toEqual([tickets[0].ticketTypeId === full.ticketTypeId ? 1 : 0, tickets[0].ticketTypeId === half.ticketTypeId ? 1 : 0]);
  });
});
