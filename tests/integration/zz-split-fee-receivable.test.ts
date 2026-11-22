// Valor fixo não reembolsável com o split do Mercado Pago: o estorno devolve a comissão
// proporcionalmente, a parte do fixo que fica com o organizador vira saldo devedor
// (ORGANIZER_RECEIVABLE) e é compensada nas próximas cobranças dele (feeRecoveryCents).
import { beforeEach, describe, expect, it } from "vitest";
import type { LedgerAccount } from "@/generated/prisma/client";
import { setCommissionRule } from "@/server/services/commission";
import { organizerReceivableCents, postSale, reserveFeeRecoveryCents } from "@/server/services/ledger";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { requestCustomerRefund } from "@/server/services/refunds";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const DAY = 86_400_000;

async function setup() {
  const admin = await makeUser({ admin: true });
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { startsInDays: 40, tickets: [{ priceCents: 10_000, quantityTotal: 50 }] });
  await db.event.update({ where: { id: event.id }, data: { refundWindowDays: 30 } });
  await setCommissionRule(db, admin, {
    scope: "EVENT",
    eventId: event.id,
    percentBps: 1000,
    fixedCentsPerTicket: 300,
    bearer: "BUYER",
    processingFeeBearer: "ORGANIZER",
    refundCommissionOnRefund: true,
    fixedFeeRefundable: false,
  });
  const [type] = await db.ticketType.findMany({ where: { eventId: event.id } });
  return { org, event, type };
}

/** Compra paga tratada como pagamento real (com split): o razão do estorno segue o provedor. */
async function paidRealOrder(eventId: string, ticketTypeId: string, quantity: number) {
  const buyer = await makeUser();
  const { order } = await buyAndPay(buyer, eventId, [{ ticketTypeId, quantity }]);
  await db.order.update({ where: { id: order.id }, data: { isSimulated: false } });
  return { buyer, order: await db.order.findUniqueOrThrow({ where: { id: order.id } }) };
}

async function net(orderId: string, account: LedgerAccount) {
  const rows = await db.financialLedgerEntry.findMany({ where: { orderId, account } });
  return rows.reduce((s, r) => s + (r.direction === "CREDIT" ? r.amountCents : -r.amountCents), 0);
}

const owed = (organizationId: string) => db.$transaction((tx) => organizerReceivableCents(tx, organizationId));

describe("valor fixo retido com split do Mercado Pago", () => {
  it("estorno: comprador não recebe o fixo; a parte que ficou com o organizador vira saldo devedor", async () => {
    const { org, event, type } = await setup();
    const { buyer, order } = await paidRealOrder(event.id, type.id, 2);
    expect(order).toMatchObject({ totalCents: 22_600, commissionCents: 2_600, serviceFeeCents: 2_600 });

    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, new Date(order.paidAt!.getTime() + 8 * DAY));
    expect(refund).toMatchObject({ status: "SUCCEEDED", amountCents: 22_000, retainedFeeCents: 600 });

    // Split: o provedor tira 26,00 × 220/226 = 25,31 da plataforma, que devia perder só 20,00.
    expect(await owed(org.id)).toBe(531);
    expect(await net(order.id, "PLATFORM_SERVICE_FEE")).toBe(600); // a plataforma fica com o fixo…
    expect(await net(order.id, "ORGANIZER_PAYABLE")).toBe(531); // …5,31 dele estão com o organizador…
    expect(await net(order.id, "ORGANIZER_RECEIVABLE")).toBe(-531); // …que os deve
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("compensação: reserva até o saldo (sem cobrar duas vezes), quita na venda seguinte e volta no estorno dela", async () => {
    const { org, event, type } = await setup();
    const first = await paidRealOrder(event.id, type.id, 2);
    await requestCustomerRefund(db, adapter, first.buyer, first.order.id, new Date(first.order.paidAt!.getTime() + 8 * DAY));
    expect(await owed(org.id)).toBe(531);

    const second = await paidRealOrder(event.id, type.id, 1);
    const [payment] = await db.payment.findMany({ where: { orderId: second.order.id } });

    // Duas cobranças simultâneas: a trava por organização faz a segunda ver a reserva da primeira.
    let n = 0;
    const reserveAndHold = () =>
      db.$transaction(async (tx) => {
        const cents = await reserveFeeRecoveryCents(tx, org.id, second.order);
        await tx.payment.create({
          data: {
            orderId: second.order.id,
            provider: "simulated",
            method: "PIX",
            amountCents: second.order.totalCents,
            feeRecoveryCents: cents,
            isSimulated: true,
            idempotencyKey: `hold:${++n}`,
          },
        });
        return cents;
      });
    const reserved = await Promise.all([reserveAndHold(), reserveAndHold()]);
    expect(reserved.sort((a, b) => a - b)).toEqual([0, 531]);

    // Cobrança expirada libera a reserva; teto = metade da parte do organizador na venda.
    await db.payment.updateMany({ where: { idempotencyKey: { startsWith: "hold:" } }, data: { status: "EXPIRED" } });
    expect(await db.$transaction((tx) => reserveFeeRecoveryCents(tx, org.id, { totalCents: 1_000, commissionCents: 400 }))).toBe(300);
    expect(await db.$transaction((tx) => reserveFeeRecoveryCents(tx, org.id, second.order))).toBe(531);

    // A venda paga com a compensação quita o saldo: o organizador recebeu 5,31 a menos.
    await db.payment.update({ where: { id: payment.id }, data: { feeRecoveryCents: 531 } });
    await db.$transaction((tx) => postSale(tx, second.order, payment.id));
    await db.$transaction((tx) => postSale(tx, second.order, payment.id)); // idempotente
    expect(await owed(org.id)).toBe(0);
    expect(await net(second.order.id, "ORGANIZER_PAYABLE")).toBe(10_000 - 531);
    expect(await net(second.order.id, "ORGANIZER_RECEIVABLE")).toBe(531);
    expect(await checkFinancialInvariants(db)).toEqual([]);

    // Estorno integral dessa venda: o split devolve também a compensação, e a dívida volta.
    const back = await requestCustomerRefund(db, adapter, second.buyer, second.order.id, new Date(second.order.paidAt!.getTime() + 2 * DAY));
    expect(back).toMatchObject({ status: "SUCCEEDED", amountCents: 11_300, retainedFeeCents: 0 });
    expect(await owed(org.id)).toBe(531);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("sem saldo devedor não há compensação", async () => {
    const { org } = await setup();
    expect(await db.$transaction((tx) => reserveFeeRecoveryCents(tx, org.id, { totalCents: 11_300, commissionCents: 1_300 }))).toBe(0);
  });
});
