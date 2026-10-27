// Decreto 13.108, R3 (tarefa L3): durante a reserva o preço fica congelado.
// Mudar o preço do tipo de ingresso ou a regra de comissão depois de criado o
// pedido não altera itens, totais, valor enviado ao provedor nem o razão.
import { beforeEach, describe, expect, it } from "vitest";
import { setCommissionRule } from "@/server/services/commission";
import { upsertTicketType } from "@/server/services/events";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { adapter, buy, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup() {
  const admin = await makeUser({ admin: true });
  await setCommissionRule(db, admin, {
    scope: "PLATFORM",
    percentBps: 1000,
    fixedCentsPerTicket: 100,
    bearer: "BUYER",
    processingFeeBearer: "ORGANIZER",
    refundCommissionOnRefund: true,
  });
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ name: "Inteira", priceCents: 10000, quantityTotal: 50 }] });
  const tt = event.ticketTypes[0];
  const customer = await makeUser();
  const order = await buy(customer, event.id, [{ ticketTypeId: tt.id, quantity: 2 }]);
  const snapshot = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
  // 2 × (100,00 + 10% + 1,00) = 222,00
  expect(snapshot).toMatchObject({ status: "PENDING_PAYMENT", subtotalCents: 20000, serviceFeeCents: 2200, totalCents: 22200, commissionCents: 2200 });

  /** Organizador muda o preço e o admin muda a regra (plataforma e evento) com a reserva ativa. */
  async function changePrices() {
    await upsertTicketType(db, owner, event.id, { id: tt.id, name: tt.name, kind: tt.kind, priceCents: 15000, quantityTotal: tt.quantityTotal });
    await setCommissionRule(db, admin, { scope: "PLATFORM", percentBps: 2000, fixedCentsPerTicket: 500, bearer: "BUYER", processingFeeBearer: "ORGANIZER", refundCommissionOnRefund: true });
    await setCommissionRule(db, admin, { scope: "EVENT", eventId: event.id, percentBps: 1500, fixedCentsPerTicket: 300, bearer: "ORGANIZER", processingFeeBearer: "ORGANIZER", refundCommissionOnRefund: true });
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).priceCents).toBe(15000);
  }

  async function expectFrozen() {
    const now = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(now.items).toEqual(snapshot.items);
    expect(now).toMatchObject({
      subtotalCents: snapshot.subtotalCents,
      serviceFeeCents: snapshot.serviceFeeCents,
      totalCents: snapshot.totalCents,
      commissionCents: snapshot.commissionCents,
      feePolicyVersion: snapshot.feePolicyVersion,
      commissionRuleId: snapshot.commissionRuleId,
      expiresAt: snapshot.expiresAt,
    });
  }

  return { event, tt, customer, order, snapshot, changePrices, expectFrozen };
}

async function approve(providerPaymentId: string) {
  return handlePaymentWebhook(db, adapter, await adapter.simulate(providerPaymentId, "approve"));
}

describe("S — preço congelado durante a reserva", () => {
  it("mudança de preço e de regra antes de iniciar o pagamento não altera o pedido nem o valor cobrado", async () => {
    const { event, tt, customer, order, snapshot, changePrices, expectFrozen } = await setup();
    await changePrices();
    await expectFrozen();

    const payment = await startPayment(db, adapter, customer, order.id, "PIX");
    expect(payment.amountCents).toBe(snapshot.totalCents);
    expect((await db.simulatedProviderPayment.findUniqueOrThrow({ where: { id: payment.providerPaymentId! } })).amountCents).toBe(22200);

    await approve(payment.providerPaymentId!);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    await expectFrozen();
    expect(await checkFinancialInvariants(db)).toEqual([]);

    // Um pedido novo já usa o preço e a regra novos (regra do evento: comissão do organizador).
    const next = await buy(await makeUser(), event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    expect(next).toMatchObject({ subtotalCents: 15000, serviceFeeCents: 0, totalCents: 15000, commissionCents: 2550 });
  });

  it("mudança depois do PIX gerado: o mesmo QR é reaproveitado e o pagamento confirma o valor congelado", async () => {
    const { customer, order, changePrices, expectFrozen } = await setup();
    const first = await startPayment(db, adapter, customer, order.id, "PIX");
    await changePrices();
    const again = await startPayment(db, adapter, customer, order.id, "PIX");
    expect(again.id).toBe(first.id);
    expect(again.amountCents).toBe(22200);

    await approve(first.providerPaymentId!);
    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid.status).toBe("PAID");
    await expectFrozen();
    // Razão lançado com os valores do pedido, não com os do preço/regra atuais.
    const fee = await db.financialLedgerEntry.findFirstOrThrow({ where: { orderId: order.id, account: "PLATFORM_SERVICE_FEE", direction: "CREDIT" } });
    expect(fee.amountCents).toBe(2200);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });
});
