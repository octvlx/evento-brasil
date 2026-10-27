// ADR 0002, passo 1: garantias do banco para cupons, links rastreados e os
// instantâneos de preço. Regras de uso e preço são do passo 2 (serviço).
import { beforeEach, describe, expect, it } from "vitest";
import { buy, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 10 }, { priceCents: 5000, quantityTotal: 10, kind: "HALF_PRICE" }] });
  const other = await makeOrg(await makeUser());
  const otherEvent = await makeEvent(other);
  const coupon = (data: Record<string, unknown> = {}) =>
    db.coupon.create({ data: { organizationId: org.id, code: "PROMO10", discountType: "PERCENT", percentBps: 1000, createdById: owner.id, ...data } });
  return { owner, org, event, other, otherEvent, coupon };
}

describe("R — schema de cupons e links rastreados", () => {
  it("createOrder grava o preço de tabela igual ao cobrado, sem desconto", async () => {
    const { event } = await setup();
    const order = await buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    const items = await db.orderItem.findMany({ where: { orderId: order.id } });
    expect(items).toEqual([expect.objectContaining({ unitPriceCents: 10000, listUnitPriceCents: 10000, discountPerUnitCents: 0 })]);
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ discountCents: 0, couponId: null, couponCode: null });
  });

  it("CHECKs do cupom recusam valores inválidos", async () => {
    const { coupon } = await setup();
    await expect(coupon({ code: "promo10" })).rejects.toThrow(/Coupon_code_format/);
    await expect(coupon({ code: "AB" })).rejects.toThrow(/Coupon_code_format/);
    await expect(coupon({ percentBps: 0 })).rejects.toThrow(/Coupon_discount_value/);
    await expect(coupon({ percentBps: 10001 })).rejects.toThrow(/Coupon_discount_value/);
    await expect(coupon({ amountCents: 500 })).rejects.toThrow(/Coupon_discount_value/);
    await expect(coupon({ discountType: "FIXED_PER_TICKET", percentBps: null, amountCents: 0 })).rejects.toThrow(/Coupon_discount_value/);
    await expect(coupon({ maxUses: 0 })).rejects.toThrow(/Coupon_max_uses/);
    await expect(coupon({ validFrom: new Date("2026-12-02"), validUntil: new Date("2026-12-01") })).rejects.toThrow(/Coupon_validity/);
    const ok = await coupon({ discountType: "FIXED_PER_TICKET", percentBps: null, amountCents: 500 });
    await expect(db.coupon.update({ where: { id: ok.id }, data: { timesReserved: { decrement: 1 } } })).rejects.toThrow(/Coupon_counters_nonnegative/);
    // O limite de usos não é CHECK: pagamento tardio pode ultrapassá-lo (D4).
    await db.coupon.update({ where: { id: ok.id }, data: { maxUses: 1, timesRedeemed: 2 } });
  });

  it("FKs compostas impedem cupom, link e pedido de outra organização", async () => {
    const { owner, org, event, otherEvent, coupon } = await setup();
    await expect(coupon({ eventId: otherEvent.id })).rejects.toThrow();
    const link = (eventId: string, code = "abc123") =>
      db.trackingLink.create({ data: { organizationId: org.id, eventId, code, name: "Link", createdById: owner.id } });
    await expect(link(otherEvent.id)).rejects.toThrow();
    await expect(link(event.id, "ab-12")).rejects.toThrow(/TrackingLink_code_format/);
    await link(event.id);

    const foreign = await db.coupon.create({ data: { organizationId: otherEvent.organizationId, code: "OUTRA", discountType: "PERCENT", percentBps: 500, createdById: owner.id } });
    const order = await buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await expect(db.order.update({ where: { id: order.id }, data: { couponId: foreign.id, couponCode: foreign.code } })).rejects.toThrow();
    const own = await coupon({ eventId: event.id });
    await db.order.update({ where: { id: order.id }, data: { couponId: own.id, couponCode: own.code } });
  });

  it("CHECKs de desconto em Order e OrderItem", async () => {
    const { event, coupon } = await setup();
    const order = await buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    await expect(db.orderItem.update({ where: { id: item.id }, data: { discountPerUnitCents: 1000 } })).rejects.toThrow(/OrderItem_discount/);
    await expect(db.orderItem.update({ where: { id: item.id }, data: { listUnitPriceCents: 9000 } })).rejects.toThrow(/OrderItem_discount/);
    await expect(db.order.update({ where: { id: order.id }, data: { discountCents: 1000 } })).rejects.toThrow(/Order_discount/);
    await expect(db.order.update({ where: { id: order.id }, data: { couponCode: "PROMO10" } })).rejects.toThrow(/Order_discount/);
    const c = await coupon();
    await expect(db.order.update({ where: { id: order.id }, data: { couponId: c.id } })).rejects.toThrow(/Order_discount/);
  });

  it("cupom usado não pode ser apagado; sem uso, apaga junções e solta o link", async () => {
    const { owner, org, event, coupon } = await setup();
    const used = await coupon({ eventId: event.id, ticketTypes: { create: [{ ticketTypeId: event.ticketTypes[0].id }] } });
    const order = await buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await db.order.update({ where: { id: order.id }, data: { couponId: used.id, couponCode: used.code } });
    await expect(db.coupon.delete({ where: { id: used.id } })).rejects.toThrow();

    const unused = await coupon({ code: "SEMUSO", ticketTypes: { create: [{ ticketTypeId: event.ticketTypes[0].id }] } });
    const link = await db.trackingLink.create({ data: { organizationId: org.id, eventId: event.id, code: "lnk001", name: "Link", couponId: unused.id, createdById: owner.id } });
    await db.coupon.delete({ where: { id: unused.id } });
    expect(await db.couponTicketType.count({ where: { couponId: unused.id } })).toBe(0);
    expect((await db.trackingLink.findUniqueOrThrow({ where: { id: link.id } })).couponId).toBeNull();

    await db.order.update({ where: { id: order.id }, data: { trackingLinkId: link.id } });
    await expect(db.trackingLink.delete({ where: { id: link.id } })).rejects.toThrow();
  });
});
