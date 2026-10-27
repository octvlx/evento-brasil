// ADR 0002, passo 2: preço com cupom, contadores de uso no ciclo do pedido,
// travas de cupons compartilhados, atribuição de origem e verificações da
// reconciliação. Todo cenário termina com checkFinancialInvariants() == [].
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { cancelEvent } from "@/server/services/cancellation";
import { createOrder, expireStaleOrders } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { requestCustomerRefund } from "@/server/services/refunds";
import { adapter, buy, db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
});

type User = Awaited<ReturnType<typeof makeUser>>;
type Item = { ticketTypeId: string; quantity: number };
const later = (min: number) => new Date(Date.now() + min * 60_000);

const order = (user: User, eventId: string, items: Item[], extra: Record<string, unknown> = {}) =>
  createOrder(db, user, orderInput(eventId, items, extra), { providerIsSimulated: true });

async function pay(user: User, orderId: string) {
  const p = await startPayment(db, adapter, user, orderId, "PIX");
  return handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"));
}

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, {
    tickets: [
      { name: "Inteira", priceCents: 10000, quantityTotal: 50 },
      { name: "VIP", priceCents: 20000, quantityTotal: 50 },
      { name: "Meia", priceCents: 5000, quantityTotal: 50, kind: "HALF_PRICE" },
    ],
  });
  const [general, vip, half] = event.ticketTypes;
  const coupon = (data: Partial<Prisma.CouponUncheckedCreateInput> = {}) =>
    db.coupon.create({
      data: { organizationId: org.id, code: "PROMO10", discountType: "PERCENT", percentBps: 1000, maxUsesPerUser: null, createdById: owner.id, ...data },
    });
  return { owner, org, event, general, vip, half, coupon };
}

const counters = (id: string) => db.coupon.findUniqueOrThrow({ where: { id }, select: { timesReserved: true, timesRedeemed: true } });

describe("S — preço com cupom", () => {
  it("10%: desconto antes das taxas, instantâneos no pedido, uso reservado → resgatado; reembolso não devolve", async () => {
    const { event, general, coupon } = await setup();
    const c = await coupon();
    const buyer = await makeUser();
    const o = await order(buyer, event.id, [{ ticketTypeId: general.id, quantity: 2 }], { couponCode: "promo10" });
    expect(o).toMatchObject({ couponId: c.id, couponCode: "PROMO10", discountCents: 2000, subtotalCents: 18000, totalCents: 18000, commissionCents: 1260 });
    const [item] = await db.orderItem.findMany({ where: { orderId: o.id } });
    expect(item).toMatchObject({ listUnitPriceCents: 10000, discountPerUnitCents: 1000, unitPriceCents: 9000, commissionPerUnitCents: 630 });
    expect(await counters(c.id)).toEqual({ timesReserved: 1, timesRedeemed: 0 });

    expect((await pay(buyer, o.id)).body).toBe("paid");
    expect(await counters(c.id)).toEqual({ timesReserved: 0, timesRedeemed: 1 });
    const funds = await db.financialLedgerEntry.findFirstOrThrow({ where: { orderId: o.id, account: "CUSTOMER_FUNDS", direction: "DEBIT" } });
    expect(funds.amountCents).toBe(18000);

    expect((await requestCustomerRefund(db, adapter, buyer, o.id)).status).toBe("SUCCEEDED");
    expect(await counters(c.id)).toEqual({ timesReserved: 0, timesRedeemed: 1 });
  });

  it("código inexistente, de outra organização, de outro evento, desativado ou malformado: mesma mensagem, nada reservado", async () => {
    const { owner, org, event, general, coupon } = await setup();
    const otherOrg = await makeOrg(await makeUser());
    await db.coupon.create({ data: { organizationId: otherOrg.id, code: "OUTRA", discountType: "PERCENT", percentBps: 1000, createdById: owner.id } });
    const otherEvent = await makeEvent(org);
    await coupon({ code: "OUTROEVENTO", eventId: otherEvent.id });
    await coupon({ code: "DESATIVADO", disabledAt: new Date() });
    const buyer = await makeUser();
    for (const code of ["NAOEXISTE", "OUTRA", "OUTROEVENTO", "DESATIVADO", "a!"]) {
      await expect(order(buyer, event.id, [{ ticketTypeId: general.id, quantity: 1 }], { couponCode: code })).rejects.toMatchObject({
        code: "VALIDATION",
        message: "Cupom inválido ou indisponível.",
      });
    }
    expect(await db.order.count()).toBe(0);
  });

  it("fora da validade e tipo não elegível são recusados", async () => {
    const { event, general, vip, coupon } = await setup();
    await coupon({ code: "VENCIDO", validUntil: later(-1) });
    await coupon({ code: "FUTURO", validFrom: later(60) });
    const vipOnly = await coupon({ code: "SOVIP" });
    await db.couponTicketType.create({ data: { couponId: vipOnly.id, ticketTypeId: vip.id } });
    const buyer = await makeUser();
    const items = [{ ticketTypeId: general.id, quantity: 1 }];
    await expect(order(buyer, event.id, items, { couponCode: "VENCIDO" })).rejects.toThrow(/fora do período/);
    await expect(order(buyer, event.id, items, { couponCode: "FUTURO" })).rejects.toThrow(/fora do período/);
    await expect(order(buyer, event.id, items, { couponCode: "SOVIP" })).rejects.toThrow(/não vale para os ingressos/);
    const ok = await order(buyer, event.id, [...items, { ticketTypeId: vip.id, quantity: 1 }], { couponCode: "SOVIP" });
    expect(ok.discountCents).toBe(2000); // só o VIP
  });

  it("meia-entrada não recebe desconto; cupom que deixaria a inteira abaixo da meia é recusado", async () => {
    const { event, general, half, coupon } = await setup();
    await coupon();
    await coupon({ code: "SESSENTA", percentBps: 6000 });
    const buyer = await makeUser();
    await expect(order(buyer, event.id, [{ ticketTypeId: half.id, quantity: 1 }], { couponCode: "PROMO10", halfPriceDeclaration: true })).rejects.toThrow(
      /não vale para os ingressos/,
    );
    const mixed = await order(buyer, event.id, [{ ticketTypeId: general.id, quantity: 1 }, { ticketTypeId: half.id, quantity: 1 }], {
      couponCode: "PROMO10",
      halfPriceDeclaration: true,
    });
    expect(mixed).toMatchObject({ discountCents: 1000, subtotalCents: 9000 + 5000 });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: general.id, quantity: 1 }], { couponCode: "SESSENTA" })).rejects.toThrow(/meia-entrada/);
  });

  it("guarda B1 com cupom; cupom de 100% vira pedido gratuito resgatado uma única vez", async () => {
    const { org, coupon } = await setup();
    // Evento sem meia-entrada: aqui só a guarda B1 deve atuar.
    const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 50 }] });
    const [general] = event.ticketTypes;
    await db.commissionRule.updateMany({ where: { scope: "PLATFORM" }, data: { fixedCentsPerTicket: 100, bearer: "ORGANIZER" } });
    await coupon({ code: "QUASETUDO", discountType: "FIXED_PER_TICKET", percentBps: null, amountCents: 9950 });
    const cortesia = await coupon({ code: "CORTESIA", percentBps: 10000 });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: general.id, quantity: 1 }], { couponCode: "QUASETUDO" })).rejects.toThrow(
      /Desconto alto demais/,
    );
    const free = await order(await makeUser(), event.id, [{ ticketTypeId: general.id, quantity: 2 }], { couponCode: "CORTESIA" });
    expect(free).toMatchObject({ status: "PAID", totalCents: 0, commissionCents: 0, discountCents: 20000 });
    expect(await db.issuedTicket.count({ where: { orderId: free.id } })).toBe(2);
    expect(await counters(cortesia.id)).toEqual({ timesReserved: 0, timesRedeemed: 1 });
  });
});

describe("S — limites de uso", () => {
  it("maxUses = 1 com 10 compras simultâneas: exatamente 1 sucesso", async () => {
    const { event, general, coupon } = await setup();
    const c = await coupon({ maxUses: 1 });
    const buyers = await Promise.all(Array.from({ length: 10 }, () => makeUser()));
    const results = await Promise.allSettled(buyers.map((b) => order(b, event.id, [{ ticketTypeId: general.id, quantity: 1 }], { couponCode: "PROMO10" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ message: "Cupom esgotado." });
    expect(await counters(c.id)).toEqual({ timesReserved: 1, timesRedeemed: 0 });
  });

  it("maxUsesPerUser: trocar o pedido pendente não gasta uso; pago (ou reembolsado) conta", async () => {
    const { event, general, coupon } = await setup();
    const c = await coupon({ maxUsesPerUser: 1 });
    const buyer = await makeUser();
    const items = [{ ticketTypeId: general.id, quantity: 1 }];
    await order(buyer, event.id, items, { couponCode: "PROMO10" });
    const second = await order(buyer, event.id, items, { couponCode: "PROMO10" }); // substitui o anterior
    expect(await counters(c.id)).toEqual({ timesReserved: 1, timesRedeemed: 0 });
    await pay(buyer, second.id);
    await requestCustomerRefund(db, adapter, buyer, second.id);
    await expect(order(buyer, event.id, items, { couponCode: "PROMO10" })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("expiração libera o uso reservado", async () => {
    const { event, general, coupon } = await setup();
    const c = await coupon({ maxUses: 1 });
    const items = [{ ticketTypeId: general.id, quantity: 1 }];
    await order(await makeUser(), event.id, items, { couponCode: "PROMO10" });
    await expect(order(await makeUser(), event.id, items, { couponCode: "PROMO10" })).rejects.toThrow(/esgotado/);
    expect(await expireStaleOrders(db, later(16))).toBe(1);
    expect(await counters(c.id)).toEqual({ timesReserved: 0, timesRedeemed: 0 });
    await order(await makeUser(), event.id, items, { couponCode: "PROMO10" });
    expect(await counters(c.id)).toEqual({ timesReserved: 1, timesRedeemed: 0 });
  });

  it("pagamento tardio acima do limite é honrado e auditado", async () => {
    const { event, general, coupon } = await setup();
    const c = await coupon({ maxUses: 1 });
    const items = [{ ticketTypeId: general.id, quantity: 1 }];
    const a = await makeUser();
    const late = await order(a, event.id, items, { couponCode: "PROMO10" });
    const p = await startPayment(db, adapter, a, late.id, "PIX");
    await expireStaleOrders(db, later(16));
    const b = await makeUser();
    const onTime = await order(b, event.id, items, { couponCode: "PROMO10" });
    await pay(b, onTime.id);

    const res = await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"));
    expect(res.body).toBe("late_paid");
    expect(await counters(c.id)).toEqual({ timesReserved: 0, timesRedeemed: 2 });
    expect(await db.auditLog.count({ where: { action: "coupon.redeemed_over_limit", entityId: c.id } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: late.id } })).totalCents).toBe(9000);
  });

  it("pagamento tardio sem estoque: reembolso automático e o uso não é resgatado", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 1 }] });
    const c = await db.coupon.create({ data: { organizationId: org.id, code: "PROMO10", discountType: "PERCENT", percentBps: 1000, createdById: owner.id } });
    const items = [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }];
    const a = await makeUser();
    const late = await order(a, event.id, items, { couponCode: "PROMO10" });
    const p = await startPayment(db, adapter, a, late.id, "PIX");
    await expireStaleOrders(db, later(16));
    await buy(await makeUser(), event.id, items); // leva o último ingresso, sem cupom
    const res = await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"));
    expect(res.body).toBe("late_payment_refund");
    expect(await counters(c.id)).toEqual({ timesReserved: 0, timesRedeemed: 0 });
  });

  it("cancelamento do evento libera os usos reservados de vários cupons", async () => {
    const { owner, event, general, coupon } = await setup();
    const c1 = await coupon({ code: "PRIMEIRO" });
    const c2 = await coupon({ code: "DOIS", eventId: event.id });
    const items = [{ ticketTypeId: general.id, quantity: 1 }];
    await order(await makeUser(), event.id, items, { couponCode: "PRIMEIRO" });
    await order(await makeUser(), event.id, items, { couponCode: "DOIS" });
    await cancelEvent(db, adapter, owner, event.id, "Chuva");
    expect(await counters(c1.id)).toEqual({ timesReserved: 0, timesRedeemed: 0 });
    expect(await counters(c2.id)).toEqual({ timesReserved: 0, timesRedeemed: 0 });
  });
});

describe("S — concorrência com cupom de organização compartilhado", () => {
  it("trocas de pedido cruzadas entre dois eventos não travam (C1→C2 × C2→C1)", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const e1 = await makeEvent(org);
    const e2 = await makeEvent(org);
    const mk = (code: string) => db.coupon.create({ data: { organizationId: org.id, code, discountType: "PERCENT", percentBps: 1000, maxUsesPerUser: null, createdById: owner.id } });
    const [c1, c2] = await Promise.all([mk("CUPOMUM"), mk("CUPOMDOIS")]);
    const pairs = await Promise.all(Array.from({ length: 4 }, async () => ({ x: await makeUser(), y: await makeUser() })));
    const i1 = [{ ticketTypeId: e1.ticketTypes[0].id, quantity: 1 }];
    const i2 = [{ ticketTypeId: e2.ticketTypes[0].id, quantity: 1 }];
    // x tem pendente em e1 com C1; y tem pendente em e2 com C2.
    for (const { x, y } of pairs) {
      await order(x, e1.id, i1, { couponCode: "CUPOMUM" });
      await order(y, e2.id, i2, { couponCode: "CUPOMDOIS" });
    }
    const codes = ["CUPOMUM", "CUPOMDOIS"];
    for (let round = 0; round < 4; round++) {
      // Ao mesmo tempo: x libera seu cupom atual e reserva o outro em e1; y faz o inverso em e2.
      // Sem travar os dois cupons em ordem de id, isso é C1→C2 contra C2→C1 (deadlock).
      const results = await Promise.allSettled(
        pairs.flatMap(({ x, y }) => [order(x, e1.id, i1, { couponCode: codes[(round + 1) % 2] }), order(y, e2.id, i2, { couponCode: codes[round % 2] })]),
      );
      expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    }
    const total = (await counters(c1.id)).timesReserved + (await counters(c2.id)).timesReserved;
    expect(total).toBe(pairs.length * 2);
  });
});

describe("S — atribuição de origem", () => {
  it("link do evento é gravado; link de outro evento é descartado; UTMs truncados em 200", async () => {
    const { owner, org, event, general } = await setup();
    const otherEvent = await makeEvent(org);
    const link = await db.trackingLink.create({
      data: { organizationId: org.id, eventId: event.id, code: "insta123", name: "Instagram", utmSource: "instagram", utmMedium: "social", createdById: owner.id },
    });
    const foreign = await db.trackingLink.create({ data: { organizationId: org.id, eventId: otherEvent.id, code: "outro123", name: "Outro", createdById: owner.id } });
    const items = [{ ticketTypeId: general.id, quantity: 1 }];

    const viaLink = await order(await makeUser(), event.id, items, { attribution: { trackingLinkId: link.id } });
    expect(viaLink).toMatchObject({ trackingLinkId: link.id, utmSource: "instagram", utmMedium: "social", utmCampaign: null });

    const viaForeign = await order(await makeUser(), event.id, items, { attribution: { trackingLinkId: foreign.id, utmSource: "x" } });
    expect(viaForeign).toMatchObject({ trackingLinkId: null, utmSource: null });

    const loose = await order(await makeUser(), event.id, items, { attribution: { utmSource: "  google  ", utmCampaign: "c".repeat(500) } });
    expect(loose.trackingLinkId).toBeNull();
    expect(loose.utmSource).toBe("google");
    expect(loose.utmCampaign).toHaveLength(200);
  });
});

describe("S — proteção e verificações", () => {
  it("limita tentativas de cupom por comprador", async () => {
    const { event, general } = await setup();
    const buyer = await makeUser();
    const items = [{ ticketTypeId: general.id, quantity: 1 }];
    for (let i = 0; i < 10; i++) await expect(order(buyer, event.id, items, { couponCode: `CHUTE${i}` })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(order(buyer, event.id, items, { couponCode: "CHUTE10" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("o verificador acusa contador de cupom e desconto do pedido divergentes", async () => {
    const { event, general, coupon } = await setup();
    const c = await coupon();
    const o = await order(await makeUser(), event.id, [{ ticketTypeId: general.id, quantity: 1 }], { couponCode: "PROMO10" });
    await db.coupon.update({ where: { id: c.id }, data: { timesReserved: { increment: 1 } } });
    await db.order.update({ where: { id: o.id }, data: { discountCents: { increment: 1 } } });
    const codes = (await checkFinancialInvariants(db)).map((v) => v.code);
    expect(codes).toEqual(expect.arrayContaining(["COUPON_COUNTERS_MISMATCH", "ORDER_DISCOUNT_MISMATCH"]));
    await db.coupon.update({ where: { id: c.id }, data: { timesReserved: { decrement: 1 } } });
    await db.order.update({ where: { id: o.id }, data: { discountCents: { decrement: 1 } } });
  });

  it("o verificador acusa cupom de evento ligado a pedido de outro evento", async () => {
    const { org, event, general, coupon } = await setup();
    const otherEvent = await makeEvent(org);
    const c = await coupon({ eventId: event.id });
    const o = await order(await makeUser(), event.id, [{ ticketTypeId: general.id, quantity: 1 }], { couponCode: "PROMO10" });
    await db.coupon.update({ where: { id: c.id }, data: { eventId: otherEvent.id } });
    expect((await checkFinancialInvariants(db)).map((v) => v.code)).toContain("COUPON_TENANT_MISMATCH");
    await db.coupon.update({ where: { id: c.id }, data: { eventId: event.id } });
    expect(o.couponId).toBe(c.id);
  });
});
