// Cupons da organização inteira (eventId nulo): cadastro, edição, avisos por evento,
// permissões e uso no checkout em eventos diferentes.
import { beforeEach, describe, expect, it } from "vitest";
import { createCoupon, createOrganizationCoupon, listEventCoupons, listOrganizationCoupons, updateCoupon } from "@/server/services/coupons";
import { createOrder } from "@/server/services/orders";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";
import type { CouponInput } from "@/features/schemas";

beforeEach(resetDb);

const coupon = (over: Partial<CouponInput> = {}): CouponInput => ({ code: "TODOS10", discountType: "PERCENT", percentBps: 1000, maxUsesPerUser: null, ...over });

async function setup() {
  const owner = await makeUser();
  const finance = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: finance.id, role: "FINANCE" }] });
  const a = await makeEvent(org, { startsInDays: 10, tickets: [{ priceCents: 10000, quantityTotal: 50 }] });
  const b = await makeEvent(org, { startsInDays: 20, tickets: [{ priceCents: 4000, quantityTotal: 50 }] });
  return { owner, finance, org, a, b };
}

describe("createOrganizationCoupon", () => {
  it("cria cupom sem evento, auditado, com validade no horário de Brasília", async () => {
    const { owner, org } = await setup();
    const { coupon: c } = await createOrganizationCoupon(db, owner, org.id, coupon({ validUntilLocal: "2030-01-31T23:59" }));
    expect(c).toMatchObject({ eventId: null, organizationId: org.id, code: "TODOS10", percentBps: 1000 });
    expect(c.validUntil?.toISOString()).toBe("2030-02-01T02:59:00.000Z");
    expect(await db.auditLog.count({ where: { entityId: c.id, action: "coupon.created" } })).toBe(1);
    expect((await listOrganizationCoupons(db, owner, org.id)).map((x) => [x.code, x.organizationWide])).toEqual([["TODOS10", true]]);
  });

  it("vale no checkout de qualquer evento da organização", async () => {
    const { owner, org, a, b } = await setup();
    await createOrganizationCoupon(db, owner, org.id, coupon());
    const buyer = await makeUser();
    const oa = await createOrder(db, buyer, orderInput(a.id, [{ ticketTypeId: a.ticketTypes[0].id, quantity: 1 }], { couponCode: "todos10" }), { providerIsSimulated: true });
    const ob = await createOrder(db, buyer, orderInput(b.id, [{ ticketTypeId: b.ticketTypes[0].id, quantity: 2 }], { couponCode: "TODOS10" }), { providerIsSimulated: true });
    expect(oa.discountCents).toBe(1000);
    expect(ob.discountCents).toBe(800);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("recusa tipos de ingresso, código repetido na organização e quem não edita eventos", async () => {
    const { owner, finance, org, a } = await setup();
    await expect(createOrganizationCoupon(db, owner, org.id, coupon({ ticketTypeIds: [a.ticketTypes[0].id] }))).rejects.toMatchObject({ code: "VALIDATION" });
    await createCoupon(db, owner, a.id, coupon({ code: "EVENTO5", percentBps: 500 }));
    await expect(createOrganizationCoupon(db, owner, org.id, coupon({ code: "EVENTO5" }))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createOrganizationCoupon(db, finance, org.id, coupon())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createOrganizationCoupon(db, await makeUser(), org.id, coupon())).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    // A lista da organização só tem os cupons sem evento; o do evento fica no evento.
    expect(await listOrganizationCoupons(db, owner, org.id)).toEqual([]);
    expect((await listEventCoupons(db, owner, a.id)).map((c) => c.code)).toEqual(["EVENTO5"]);
  });

  it("avisa, por evento aberto, quando o desconto passa da meia-entrada", async () => {
    const { owner, org } = await setup();
    const c = await makeEvent(org, { startsInDays: 15, tickets: [{ priceCents: 5000, quantityTotal: 50 }, { priceCents: 2500, quantityTotal: 50, kind: "HALF_PRICE" }] });
    const { warnings } = await createOrganizationCoupon(db, owner, org.id, coupon({ code: "METADE60", percentBps: 6000 }));
    expect(warnings.some((w) => w.startsWith(`${c.title} — `) && /meia-entrada/.test(w))).toBe(true);
  });
});

describe("updateCoupon com cupom da organização", () => {
  it("edita limites e validade; depois de usado, código e desconto ficam fixos", async () => {
    const { owner, org, a } = await setup();
    const { coupon: c } = await createOrganizationCoupon(db, owner, org.id, coupon());
    const { coupon: up } = await updateCoupon(db, owner, c.id, coupon({ maxUses: 50, validFromLocal: "2026-01-01T00:00" }));
    expect(up).toMatchObject({ eventId: null, maxUses: 50 });
    expect(up.validFrom?.toISOString()).toBe("2026-01-01T03:00:00.000Z");
    await expect(updateCoupon(db, owner, c.id, coupon({ ticketTypeIds: [a.ticketTypes[0].id] }))).rejects.toMatchObject({ code: "VALIDATION" });

    await createOrder(db, await makeUser(), orderInput(a.id, [{ ticketTypeId: a.ticketTypes[0].id, quantity: 1 }], { couponCode: "TODOS10" }), { providerIsSimulated: true });
    await expect(updateCoupon(db, owner, c.id, coupon({ percentBps: 2000 }))).rejects.toThrow(/já foi usado/);
    expect((await updateCoupon(db, owner, c.id, coupon({ maxUses: 80 }))).coupon.maxUses).toBe(80);
  });

  it("outra organização não edita", async () => {
    const { owner, org } = await setup();
    const { coupon: c } = await createOrganizationCoupon(db, owner, org.id, coupon());
    const other = await makeUser();
    await makeOrg(other);
    await expect(updateCoupon(db, other, c.id, coupon({ maxUses: 5 }))).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
  });
});
