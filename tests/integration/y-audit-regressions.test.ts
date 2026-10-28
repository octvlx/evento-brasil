import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicEvent, searchEvents } from "@/server/services/catalog";
import { resolveCommissionRule, resolveCommissionRules } from "@/server/services/commission";
import { applyPaymentSnapshot } from "@/server/services/payments";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

describe("audit: catalogue queries and stock", () => {
  it("resolves all card prices in one commission query with event/org/platform precedence", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const otherOrg = await makeOrg(await makeUser());
    const events = await Promise.all([makeEvent(org), makeEvent(org), makeEvent(otherOrg)]);
    await db.commissionRule.create({ data: { scope: "ORGANIZATION", organizationId: org.id, percentBps: 1000, bearer: "BUYER", policyVersion: "audit:org" } });
    await db.commissionRule.create({ data: { scope: "EVENT", eventId: events[0].id, percentBps: 2000, bearer: "BUYER", policyVersion: "audit:event" } });
    const expected = await Promise.all(events.map((event) => resolveCommissionRule(db, event.organizationId, event.id)));
    const spy = vi.spyOn(db.commissionRule, "findMany");
    try {
      const cards = (await searchEvents(db, {})).events;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(cards.find((card) => card.id === events[0].id)?.minPrice?.totalCents).toBe(12000);
      expect(cards.find((card) => card.id === events[1].id)?.minPrice?.totalCents).toBe(11000);
      expect(cards.find((card) => card.id === events[2].id)?.minPrice?.totalCents).toBe(10000);
      const rules = await resolveCommissionRules(db, events);
      expect(events.map((event) => rules.get(event.id)?.id)).toEqual(expected.map((rule) => rule.id));
    } finally { spy.mockRestore(); }
  });

  it("batch lookup respects rule activation and expiry, and empty lists do not query", async () => {
    const event = await makeEvent(await makeOrg(await makeUser()));
    const at = new Date(Date.now() + 60_000);
    for (const [name, from, to] of [
      ["expired", new Date(at.getTime() - 10_000), at],
      ["future", new Date(at.getTime() + 10_000), null],
    ] as const) {
      await db.commissionRule.create({ data: { scope: "EVENT", eventId: event.id, percentBps: 1000, activeFrom: from, activeTo: to, policyVersion: `audit:${name}` } });
    }
    expect((await resolveCommissionRules(db, [event], at)).get(event.id)?.scope).toBe("PLATFORM");
    const spy = vi.spyOn(db.commissionRule, "findMany");
    try {
      expect((await resolveCommissionRules(db, [])).size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("hidden lots consume capacity but never appear in public prices or ticket selection", async () => {
    const event = await makeEvent(await makeOrg(await makeUser()), { capacity: 2, tickets: [{ priceCents: 10000, quantityTotal: 2 }, { priceCents: 1, quantityTotal: 2 }] });
    await db.ticketType.update({ where: { id: event.ticketTypes[1].id }, data: { isHidden: true, quantitySold: 2 } });
    const detail = (await getPublicEvent(db, event.slug))!;
    expect(detail.capacityLeft).toBe(0);
    expect(detail.availability).toBe("SOLD_OUT");
    expect(detail.event.ticketTypes.map((type) => type.id)).toEqual([event.ticketTypes[0].id]);
    expect(detail.prices[event.ticketTypes[1].id]).toBeUndefined();
    const card = (await searchEvents(db, {})).events[0];
    expect(card.availability).toBe("SOLD_OUT");
    expect(card.minPriceCents).toBe(10000);
  });

  it("hidden half-price sales still consume the public half-price quota", async () => {
    const event = await makeEvent(await makeOrg(await makeUser()), { capacity: 10, halfPriceQuotaBps: 5000, tickets: [{ priceCents: 5000, quantityTotal: 5, kind: "HALF_PRICE" }, { priceCents: 4000, quantityTotal: 5, kind: "HALF_PRICE" }] });
    await db.ticketType.update({ where: { id: event.ticketTypes[1].id }, data: { isHidden: true, quantitySold: 4 } });
    expect((await getPublicEvent(db, event.slug))?.halfPriceLeft).toBe(1);
  });

  it("lot-specific sale windows are reflected in availability", async () => {
    const event = await makeEvent(await makeOrg(await makeUser()));
    await db.ticketType.update({ where: { id: event.ticketTypes[0].id }, data: { salesStartAt: new Date(Date.now() + 60_000) } });
    expect((await searchEvents(db, {})).events[0].availability).toBe("NOT_STARTED");
    await db.ticketType.update({ where: { id: event.ticketTypes[0].id }, data: { salesStartAt: null, salesEndAt: new Date(Date.now() - 60_000) } });
    expect((await getPublicEvent(db, event.slug))?.availability).toBe("CLOSED");
  });

  it.each([NaN, Infinity, -Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER])("invalid page %s cannot cause a database pagination error", async (page) => {
    expect((await searchEvents(db, { page })).page).toBe(1);
  });
});

describe("audit: mutually exclusive payment reversals", () => {
  it.each(["REFUNDED", "CHARGED_BACK"] as const)("a payment already %s cannot be reversed a second time", async (first) => {
    const event = await makeEvent(await makeOrg(await makeUser()));
    const buyer = await makeUser();
    const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const snapshot = await adapter.getPayment(payment.providerPaymentId!);
    await applyPaymentSnapshot(db, adapter, { ...snapshot, status: first });
    const entries = await db.financialLedgerEntry.findMany({ where: { orderId: order.id } });
    expect(await applyPaymentSnapshot(db, adapter, { ...snapshot, status: first === "REFUNDED" ? "CHARGED_BACK" : "REFUNDED" })).toBe("no_change");
    expect(await db.financialLedgerEntry.findMany({ where: { orderId: order.id } })).toEqual(entries);
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: first });
  });
});
