import { beforeEach, describe, expect, it } from "vitest";
import { createCheckoutDraft, getCheckoutReview, prepareCheckoutReview, confirmCheckoutReview, updateCheckoutDraft } from "@/server/services/checkout-review";
import { startPayment, handlePaymentWebhook } from "@/server/services/payments";
import { encryptPII, hashToken } from "@/server/crypto";
import { adapter, db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);
async function setup(priceCents = 10000, quantityTotal = 10) {
  const owner = await makeUser(); const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ priceCents, quantityTotal }] });
  let buyer = await makeUser();
  buyer = await db.user.update({ where: { id: buyer.id }, data: { emailVerifiedAt: new Date(), cpfEncrypted: encryptPII("52998224725"), cpfHash: hashToken("52998224725"), cpfLast2: "25", birthDate: new Date("1990-01-01T00:00:00Z") } });
  await db.userAddress.create({ data: { userId: buyer.id, postalCode: "01001000", street: "Praça da Sé", number: "1", district: "Sé", city: "São Paulo", state: "SP" } });
  const selection = orderInput(event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  const draft = await createCheckoutDraft(db, selection);
  return { buyer, event, selection, ...draft };
}

describe("checkout review orchestrates the existing order/payment domain", () => {
  it("persists pre-auth selection without reserving or issuing, and only claims with its secret", async () => {
    const x = await setup();
    expect(await db.order.count()).toBe(0);
    expect(await db.ticketInventoryReservation.count()).toBe(0);
    await expect(getCheckoutReview(db, x.buyer, x.draftId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const review = await getCheckoutReview(db, x.buyer, x.draftId, x.token);
    expect(review.draft.selection).toMatchObject({ items: x.selection.items });
    expect(review.order).toBeNull();
    const repeated = await createCheckoutDraft(db, x.selection);
    expect(repeated).toEqual({ draftId: x.draftId, token: x.token });
  });
  it("blocks first purchase without verified email, personal details or address", async () => {
    const x = await setup();
    await db.user.update({ where: { id: x.buyer.id }, data: { emailVerifiedAt: null } });
    await expect(prepareCheckoutReview(db, x.buyer, x.draftId, x.token)).rejects.toThrow("Confirme seu e-mail");
    await db.user.update({ where: { id: x.buyer.id }, data: { emailVerifiedAt: new Date(), cpfEncrypted: null, cpfHash: null, cpfLast2: null } });
    await expect(prepareCheckoutReview(db, x.buyer, x.draftId, x.token)).rejects.toThrow("CPF");
    await db.user.update({ where: { id: x.buyer.id }, data: { cpfEncrypted: encryptPII("52998224725"), cpfHash: hashToken("52998224725"), cpfLast2: "25" } });
    await db.userAddress.delete({ where: { userId: x.buyer.id } });
    await expect(prepareCheckoutReview(db, x.buyer, x.draftId, x.token)).rejects.toThrow("endereço");
    expect(await db.order.count()).toBe(0);
  });
  it("serializes repeated preparation and preserves cart/order on refresh", async () => {
    const x = await setup();
    const prepared = await Promise.all([prepareCheckoutReview(db, x.buyer, x.draftId, x.token), prepareCheckoutReview(db, x.buyer, x.draftId, x.token)]);
    expect(prepared[0].order!.id).toBe(prepared[1].order!.id);
    expect(await db.order.count()).toBe(1);
    const refresh = await getCheckoutReview(db, x.buyer, x.draftId);
    expect(refresh.reviewHash).toBe(prepared[0].reviewHash);
    expect(refresh.order!.totalCents).toBe(10000);
    expect(refresh.order!.items[0].quantity).toBe(1);
    await expect(startPayment(db, adapter, x.buyer, refresh.order!.id, "PIX")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
  it("requires renewed confirmation after a backend price change", async () => {
    const x = await setup(); const review = await prepareCheckoutReview(db, x.buyer, x.draftId, x.token);
    await db.ticketType.update({ where: { id: x.event.ticketTypes[0].id }, data: { priceCents: 12000 } });
    const changed = await confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!);
    expect(changed.changed).toBe(true);
    const next = await getCheckoutReview(db, x.buyer, x.draftId);
    expect(next.order!.totalCents).toBe(12000);
    expect((await db.order.findUniqueOrThrow({ where: { id: review.order!.id } })).status).toBe("CANCELLED");
    expect(await db.payment.count()).toBe(0);
    expect((await confirmCheckoutReview(db, x.buyer, x.draftId, next.reviewHash!)).changed).toBe(false);
  });
  it("quantity edits preserve valid coupon and account address, reprice using the same finance service", async () => {
    const x = await setup();
    const org = await db.organization.findFirstOrThrow();
    await db.coupon.create({ data: { organizationId: org.id, eventId: x.event.id, code: "REVIEW10", discountType: "PERCENT", percentBps: 1000, createdById: x.buyer.id } });
    await updateCheckoutDraft(db, x.buyer, x.draftId, { ...x.selection, couponCode: "REVIEW10" }, x.token);
    await prepareCheckoutReview(db, x.buyer, x.draftId);
    await updateCheckoutDraft(db, x.buyer, x.draftId, { ...x.selection, items: [{ ticketTypeId: x.event.ticketTypes[0].id, quantity: 2 }], couponCode: "REVIEW10" });
    const next = await prepareCheckoutReview(db, x.buyer, x.draftId);
    expect(next.order).toMatchObject({ subtotalCents: 18000, discountCents: 2000, totalCents: 18000, couponCode: "REVIEW10" });
    expect(await db.userAddress.count({ where: { userId: x.buyer.id } })).toBe(1);
    expect(await db.issuedTicket.count()).toBe(0);
  });
  it("rechecks profile/address edits before payment and preserves the existing reservation", async () => {
    const x = await setup(); const review = await prepareCheckoutReview(db, x.buyer, x.draftId, x.token);
    await confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!);
    await db.userAddress.update({ where: { userId: x.buyer.id }, data: { number: "2" } });
    await expect(startPayment(db, adapter, x.buyer, review.order!.id, "PIX")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!)).changed).toBe(true);
    const next = await getCheckoutReview(db, x.buyer, x.draftId);
    expect(next.order!.id).toBe(review.order!.id);
    await confirmCheckoutReview(db, x.buyer, x.draftId, next.reviewHash!);
    expect(await db.order.count()).toBe(1);
  });
  it("confirmed paid checkout reuses payment and issues only after verified webhook", async () => {
    const x = await setup(); const review = await prepareCheckoutReview(db, x.buyer, x.draftId, x.token);
    await Promise.all([confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!), confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!)]);
    const payment = await startPayment(db, adapter, x.buyer, review.order!.id, "PIX");
    expect((await startPayment(db, adapter, x.buyer, review.order!.id, "PIX")).id).toBe(payment.id);
    expect(await db.issuedTicket.count()).toBe(0);
    const webhook = await adapter.simulate(payment.providerPaymentId!, "approve");
    expect((await handlePaymentWebhook(db, adapter, webhook)).status).toBe(200);
    expect((await handlePaymentWebhook(db, adapter, webhook)).status).toBe(200);
    expect(await db.issuedTicket.count()).toBe(1);
    expect(await db.payment.count()).toBe(1);
  });
  it("free tickets are not issued before review and repeated confirmation issues once", async () => {
    const x = await setup(0); const review = await prepareCheckoutReview(db, x.buyer, x.draftId, x.token);
    expect(review.order!.status).toBe("PENDING_PAYMENT"); expect(await db.issuedTicket.count()).toBe(0);
    const result = await Promise.all([confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!), confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!)]);
    expect(result.every(r => r.paid)).toBe(true);
    expect(await db.issuedTicket.count()).toBe(1);
    expect(await db.payment.count()).toBe(1);
  });
  it("rejects foreign orders and expired holds without starting payment", async () => {
    const x = await setup(10000, 1); const review = await prepareCheckoutReview(db, x.buyer, x.draftId, x.token);
    const stranger = await makeUser();
    await expect(getCheckoutReview(db, stranger, x.draftId, x.token)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.order.update({ where: { id: review.order!.id }, data: { expiresAt: new Date(0) } });
    await expect(startPayment(db, adapter, x.buyer, review.order!.id, "PIX")).rejects.toBeDefined();
    expect(await db.payment.count()).toBe(0);
  });
});


describe("review consent and subsequent purchase", () => {
  it("does not issue free tickets when the current terms have not been accepted", async () => {
    const x = await setup(0); const review = await prepareCheckoutReview(db, x.buyer, x.draftId, x.token);
    await db.termsVersion.create({ data: { kind: "BUYER", version: "review-v1", textHash: "a".repeat(64), documentPath: "/termos", publishedAt: new Date(Date.now() - 1000) } });
    await expect(confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!)).rejects.toMatchObject({ code: "TERMS_REQUIRED" });
    expect(await db.issuedTicket.count()).toBe(0); expect(await db.payment.count()).toBe(0);
    expect((await db.checkoutDraft.findUniqueOrThrow({ where: { id: x.draftId } })).confirmedAt).toBeNull();
    expect((await confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!, undefined, { acceptTerms: true })).paid).toBe(true);
    expect(await db.termsAcceptance.count({ where: { userId: x.buyer.id, context: "CHECKOUT", orderId: review.order!.id } })).toBe(1);
    expect(await db.issuedTicket.count()).toBe(1);
  });
  it("reuses the address on a second purchase without collecting it again", async () => {
    const x = await setup(); const review = await prepareCheckoutReview(db, x.buyer, x.draftId, x.token);
    await confirmCheckoutReview(db, x.buyer, x.draftId, review.reviewHash!);
    const payment = await startPayment(db, adapter, x.buyer, review.order!.id, "PIX");
    await handlePaymentWebhook(db, adapter, await adapter.simulate(payment.providerPaymentId!, "approve"));
    const next = await createCheckoutDraft(db, orderInput(x.event.id, x.selection.items), x.buyer);
    const second = await prepareCheckoutReview(db, x.buyer, next.draftId);
    expect(second.readiness.address).toBe(true); expect(second.order!.id).not.toBe(review.order!.id);
    expect(await db.userAddress.count({ where: { userId: x.buyer.id } })).toBe(1);
  });
  it("rejects stock exhaustion while another reviewed cart holds the final ticket", async () => {
    const x = await setup(10000, 1); await prepareCheckoutReview(db, x.buyer, x.draftId, x.token);
    const other = await makeUser();
    await db.user.update({ where: { id: other.id }, data: { emailVerifiedAt: new Date(), cpfEncrypted: encryptPII("12345678909"), cpfHash: hashToken("12345678909"), cpfLast2: "09", birthDate: new Date("1991-01-01T00:00:00Z") } });
    await db.userAddress.create({ data: { userId: other.id, postalCode: "01001000", street: "Praça da Sé", number: "2", district: "Sé", city: "São Paulo", state: "SP" } });
    const next = await createCheckoutDraft(db, orderInput(x.event.id, x.selection.items), other);
    await expect(prepareCheckoutReview(db, other, next.draftId)).rejects.toMatchObject({ code: "SOLD_OUT" });
    expect(await db.order.count()).toBe(1); expect(await db.payment.count()).toBe(0);
  });
});
