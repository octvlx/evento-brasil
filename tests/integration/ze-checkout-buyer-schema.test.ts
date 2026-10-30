import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, makeEvent, makeOrg, makeUser, buy, resetDb } from "../support/fixtures";

beforeEach(resetDb);
const digest = () => randomUUID().replaceAll("-", "").repeat(2);
async function shop() { const owner = await makeUser(); return makeEvent(await makeOrg(owner)); }
const address = { postalCode: "01001000", street: "Praça da Sé", number: "100", district: "Sé", city: "São Paulo", state: "SP" };

describe("buyer profile and persistent checkout database invariants", () => {
  it("keeps legacy users incomplete without implying confirmed email or changing login data", async () => {
    const user = await makeUser();
    expect(user.emailVerifiedAt).toBeNull(); expect(user.cpfEncrypted).toBeNull(); expect(user.birthDate).toBeNull();
    expect(await db.userAddress.count()).toBe(0);
  });
  it("requires complete hashed encrypted CPF and prevents duplicate civil identities", async () => {
    const user = await makeUser();
    await expect(db.user.update({ where: { id: user.id }, data: { cpfEncrypted: "v1.cipher" } })).rejects.toThrow("User_buyer_cpf_complete");
    await expect(db.user.update({ where: { id: user.id }, data: { cpfEncrypted: "52998224725", cpfHash: digest(), cpfLast2: "25" } })).rejects.toThrow("User_buyer_cpf_complete");
    const cpfHash = digest();
    await db.user.update({ where: { id: user.id }, data: { cpfEncrypted: "v1.cipher", cpfHash, cpfLast2: "25", birthDate: new Date("1995-04-15") } });
    const other = await makeUser();
    await expect(db.user.update({ where: { id: other.id }, data: { cpfEncrypted: "v1.other", cpfHash, cpfLast2: "25" } })).rejects.toThrow();
    await expect(db.user.update({ where: { id: user.id }, data: { birthDate: new Date("2200-01-01") } })).rejects.toThrow("User_birth_date_range");
  });
  it("stores one reusable address per buyer and rejects malformed CEP/UF/empty required data", async () => {
    const user = await makeUser();
    for (const invalid of [{ postalCode: "bad" }, { state: "ZZ" }, { street: " " }]) {
      await expect(db.userAddress.create({ data: { userId: user.id, ...address, ...invalid } })).rejects.toThrow();
    }
    await db.userAddress.create({ data: { userId: user.id, ...address } });
    await expect(db.userAddress.create({ data: { userId: user.id, ...address } })).rejects.toThrow();
    await db.userAddress.upsert({ where: { userId: user.id }, create: { userId: user.id, ...address }, update: { number: "200" } });
    expect(await db.userAddress.count({ where: { userId: user.id } })).toBe(1);
  });
  it("only stores unique hashed expiring email verification tokens", async () => {
    const user = await makeUser(); const tokenHash = digest();
    const data = { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 600000) };
    await db.emailVerificationToken.create({ data });
    await expect(db.emailVerificationToken.create({ data })).rejects.toThrow();
    await expect(db.emailVerificationToken.create({ data: { ...data, tokenHash: "raw-secret" } })).rejects.toThrow("EmailVerificationToken_hash");
  });
  it("persists anonymous carts without reservations and enforces idempotency/revision invariants", async () => {
    const event = await shop();
    const data = { tokenHash: digest(), idempotencyKey: randomUUID(), eventId: event.id, selection: { items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }] }, expiresAt: new Date(Date.now() + 600000) };
    await db.checkoutDraft.create({ data });
    expect(await db.order.count()).toBe(0);
    await expect(db.checkoutDraft.create({ data: { ...data, tokenHash: digest() } })).rejects.toThrow();
    await expect(db.checkoutDraft.create({ data: { ...data, idempotencyKey: randomUUID(), tokenHash: digest(), revision: -1 } })).rejects.toThrow("CheckoutDraft_revision");
    await expect(db.checkoutDraft.create({ data: { ...data, idempotencyKey: randomUUID(), tokenHash: digest(), selection: [] } })).rejects.toThrow("CheckoutDraft_selection_object");
  });
  it("cannot link a cart to another buyer or event's financial order", async () => {
    const event = await shop(); const buyer = await makeUser(); const other = await makeUser();
    const order = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const data = { tokenHash: digest(), idempotencyKey: randomUUID(), userId: other.id, eventId: event.id, selection: {}, expiresAt: new Date(Date.now() + 600000), orderId: order.id };
    await expect(db.checkoutDraft.create({ data })).rejects.toThrow();
    const draft = await db.checkoutDraft.create({ data: { ...data, userId: buyer.id } });
    expect(draft.orderId).toBe(order.id);
    const anotherEvent = await shop();
    await expect(db.checkoutDraft.update({ where: { id: draft.id }, data: { eventId: anotherEvent.id } })).rejects.toThrow();
  });
});
