// Valor fixo da comissão não reembolsável: retido só no reembolso pedido pelo comprador
// depois do prazo de arrependimento, com o valor e o razão fechando. E as versões de regra:
// editar/excluir só sem pedidos.
import { beforeEach, describe, expect, it } from "vitest";
import { deleteCommissionRule, setCommissionRule, updateCommissionRule } from "@/server/services/commission";
import { cancelEvent } from "@/server/services/cancellation";
import { checkFinancialInvariants, reconcilePayments } from "@/server/services/reconciliation";
import { requestCustomerRefund } from "@/server/services/refunds";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const DAY = 86_400_000;

async function setup(opts: { fixedFeeRefundable: boolean; bearer?: "BUYER" | "ORGANIZER"; tickets?: { priceCents: number; quantityTotal: number; kind?: "HALF_PRICE" }[] }) {
  const admin = await makeUser({ admin: true });
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { startsInDays: 40, tickets: opts.tickets ?? [{ priceCents: 10_000, quantityTotal: 50 }] });
  await db.event.update({ where: { id: event.id }, data: { refundWindowDays: 30 } });
  const rule = await setCommissionRule(db, admin, {
    scope: "EVENT",
    eventId: event.id,
    percentBps: 1000,
    fixedCentsPerTicket: 300,
    bearer: opts.bearer ?? "BUYER",
    processingFeeBearer: "ORGANIZER",
    refundCommissionOnRefund: true,
    fixedFeeRefundable: opts.fixedFeeRefundable,
  });
  const types = await db.ticketType.findMany({ where: { eventId: event.id }, orderBy: { sortOrder: "asc" } });
  return { admin, owner, org, event, rule, types };
}

async function ledgerFor(orderId: string) {
  const rows = await db.financialLedgerEntry.findMany({ where: { orderId } });
  const net = (account: string) => rows.filter((r) => r.account === account).reduce((s, r) => s + (r.direction === "CREDIT" ? r.amountCents : -r.amountCents), 0);
  return { net };
}

describe("valor fixo não reembolsável", () => {
  it("compra guarda a regra; reembolso do comprador após 7 dias retém o fixo e o razão fecha", async () => {
    const { event, types } = await setup({ fixedFeeRefundable: false });
    const buyer = await makeUser();
    const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: types[0].id, quantity: 2 }]);
    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    // R$ 100 + 10% + R$ 3 = R$ 13 de taxa por ingresso (comprador paga).
    expect(paid).toMatchObject({ fixedFeeRefundable: false, totalCents: 22_600 });
    expect(paid.items[0]).toMatchObject({ fixedFeePerUnitCents: 300, commissionPerUnitCents: 1300 });

    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, new Date(paid.paidAt!.getTime() + 8 * DAY));
    expect(refund).toMatchObject({ status: "SUCCEEDED", amountCents: 22_000, retainedFeeCents: 600, reason: "CUSTOMER_REQUEST" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");

    const { net } = await ledgerFor(order.id);
    expect(net("CUSTOMER_FUNDS")).toBe(-22_600 + 22_000); // pagou 226, recebeu 220
    expect(net("PLATFORM_SERVICE_FEE")).toBe(600); // a plataforma fica com o fixo
    expect(net("ORGANIZER_PAYABLE")).toBe(0);
    expect(await checkFinancialInvariants(db)).toEqual([]);
    // Reconciliação com o provedor (estorno parcial lá) não mexe no pedido reembolsado.
    await reconcilePayments(db, adapter, new Date(Date.now() + 60 * 60_000));
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("dentro do prazo de arrependimento (7 dias) devolve tudo", async () => {
    const { event, types } = await setup({ fixedFeeRefundable: false });
    const buyer = await makeUser();
    const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: types[0].id, quantity: 1 }]);
    const paidAt = (await db.order.findUniqueOrThrow({ where: { id: order.id } })).paidAt!;
    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, new Date(paidAt.getTime() + 6 * DAY));
    expect(refund).toMatchObject({ amountCents: 11_300, retainedFeeCents: 0 });
  });

  it("regra com fixo reembolsável não retém; organizador pagando a comissão também fecha o razão", async () => {
    const refundable = await setup({ fixedFeeRefundable: true });
    const b1 = await makeUser();
    const o1 = (await buyAndPay(b1, refundable.event.id, [{ ticketTypeId: refundable.types[0].id, quantity: 1 }])).order;
    const p1 = (await db.order.findUniqueOrThrow({ where: { id: o1.id } })).paidAt!;
    expect((await requestCustomerRefund(db, adapter, b1, o1.id, new Date(p1.getTime() + 8 * DAY))).retainedFeeCents).toBe(0);

    const organizerPays = await setup({ fixedFeeRefundable: false, bearer: "ORGANIZER" });
    const b2 = await makeUser();
    const o2 = (await buyAndPay(b2, organizerPays.event.id, [{ ticketTypeId: organizerPays.types[0].id, quantity: 1 }])).order;
    const p2 = (await db.order.findUniqueOrThrow({ where: { id: o2.id } })).paidAt!;
    const r2 = await requestCustomerRefund(db, adapter, b2, o2.id, new Date(p2.getTime() + 8 * DAY));
    expect(r2).toMatchObject({ amountCents: 9_700, retainedFeeCents: 300 });
    const { net } = await ledgerFor(o2.id);
    expect(net("PLATFORM_COMMISSION")).toBe(300);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("parcial retém o fixo dos ingressos escolhidos; o cancelamento depois devolve só o resto", async () => {
    const { admin, event, types } = await setup({ fixedFeeRefundable: false });
    const buyer = await makeUser();
    const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: types[0].id, quantity: 3 }]);
    const paidAt = (await db.order.findUniqueOrThrow({ where: { id: order.id } })).paidAt!;
    const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { code: "asc" } });
    const partial = await requestCustomerRefund(db, adapter, buyer, order.id, new Date(paidAt.getTime() + 8 * DAY), [tickets[0].id]);
    expect(partial).toMatchObject({ partial: true, amountCents: 11_000, retainedFeeCents: 300 });
    expect(await checkFinancialInvariants(db)).toEqual([]);

    // Organizador/admin cancela o evento: os 2 restantes voltam inteiros (226), sem devolver de novo o já coberto.
    await cancelEvent(db, adapter, admin, event.id, "Chuva forte", { asAdmin: true });
    const refunds = await db.refund.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(refunds.map((r) => [r.reason, r.amountCents, r.retainedFeeCents, r.status])).toEqual([
      ["CUSTOMER_REQUEST", 11_000, 300, "SUCCEEDED"],
      ["EVENT_CANCELLED", 22_600, 0, "SUCCEEDED"],
    ]);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });
});

describe("editar e excluir versão de regra", () => {
  it("edita só sem pedidos; com pedido recusa e o banco impede excluir", async () => {
    const { admin, event, rule, types } = await setup({ fixedFeeRefundable: true });
    const edited = await updateCommissionRule(db, admin, rule.id, {
      percentBps: 800,
      fixedCentsPerTicket: 200,
      bearer: "BUYER",
      processingFeeBearer: "PLATFORM",
      refundCommissionOnRefund: true,
      fixedFeeRefundable: false,
    });
    expect(edited).toMatchObject({ percentBps: 800, fixedCentsPerTicket: 200, processingFeeBearer: "PLATFORM", fixedFeeRefundable: false, policyVersion: rule.policyVersion });
    expect(await db.auditLog.count({ where: { action: "commission_rule.updated", entityId: rule.id } })).toBe(1);

    await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: types[0].id, quantity: 1 }]);
    await expect(updateCommissionRule(db, admin, rule.id, { ...edited, percentBps: 100 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(deleteCommissionRule(db, admin, rule.id)).rejects.toMatchObject({ code: "CONFLICT" });
    // Mesmo sem o serviço, o banco não deixa apagar versão usada (ON DELETE RESTRICT).
    await expect(db.commissionRule.delete({ where: { id: rule.id } })).rejects.toThrow();
  });

  it("excluir a vigente reativa a anterior; numeração não se repete; plataforma nunca fica sem regra", async () => {
    const admin = await makeUser({ admin: true });
    const base = { scope: "PLATFORM" as const, fixedCentsPerTicket: 0, bearer: "ORGANIZER" as const, processingFeeBearer: "ORGANIZER" as const, refundCommissionOnRefund: true };
    const v2 = await setCommissionRule(db, admin, { ...base, percentBps: 800 });
    const v1 = await db.commissionRule.findFirstOrThrow({ where: { policyVersion: "platform:default:v1" } });
    expect(v1.activeTo).not.toBeNull();

    expect(await deleteCommissionRule(db, admin, v2.id)).toEqual({ reactivated: "platform:default:v1" });
    expect((await db.commissionRule.findUniqueOrThrow({ where: { id: v1.id } })).activeTo).toBeNull();
    // Única regra da plataforma: não exclui.
    await expect(deleteCommissionRule(db, admin, v1.id)).rejects.toMatchObject({ code: "INVALID_STATE" });

    const v3 = await setCommissionRule(db, admin, { ...base, percentBps: 900 });
    expect(v3.policyVersion).toBe("platform:default:v2");
    // Excluir uma versão antiga (encerrada) sem pedidos não reativa nada nem quebra a numeração.
    await deleteCommissionRule(db, admin, v1.id);
    const v4 = await setCommissionRule(db, admin, { ...base, percentBps: 1000 });
    expect(v4.policyVersion).toBe("platform:default:v3");
  });

  it("só quem tem finance:commissions edita ou exclui", async () => {
    const { rule } = await setup({ fixedFeeRefundable: true });
    const moderator = await db.user.update({ where: { id: (await makeUser({ admin: true })).id }, data: { adminRoles: ["MODERATION"] } });
    await expect(deleteCommissionRule(db, moderator, rule.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateCommissionRule(db, moderator, rule.id, { percentBps: 1, fixedCentsPerTicket: 0, bearer: "BUYER", processingFeeBearer: "ORGANIZER", refundCommissionOnRefund: true, fixedFeeRefundable: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
