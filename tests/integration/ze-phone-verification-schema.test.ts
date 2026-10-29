import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const challenge = (overrides: Record<string, unknown> = {}) => db.phoneVerificationChallenge.create({ data: {
  tokenHash: hash(), email: "signup@test.local", phone: "+5511999999999", clientKeyHash: hash(),
  smsConsentAt: new Date(), expiresAt: new Date(Date.now() + 600_000), ...overrides,
} });

describe("phone verification database guarantees", () => {
  it("preserves existing account compatibility without implying verified ownership", async () => {
    const user = await makeUser();
    expect(user.phoneVerifiedAt).toBeNull();
    expect((await db.user.update({ where: { id: user.id }, data: { phone: "11999999999" } })).phoneVerifiedAt).toBeNull();
  });

  it("enforces unique browser proof hashes but allows Twilio SID reuse across resend challenges", async () => {
    const first = await challenge({ providerVerificationSid: "VE-reused" });
    await expect(challenge({ tokenHash: first.tokenHash })).rejects.toThrow();
    await expect(challenge({ providerVerificationSid: first.providerVerificationSid })).resolves.toMatchObject({ providerVerificationSid: "VE-reused" });
  });

  it("rejects invalid phone formats, plaintext proof tokens, and negative counters", async () => {
    for (const [data, constraint] of [
      [{ phone: "11999999999" }, "phone_e164"],
      [{ tokenHash: "plaintext-token" }, "token_hash"],
      [{ clientKeyHash: "raw-ip" }, "client_key_hash"],
      [{ sendCount: -1 }, "nonnegative_counters"],
      [{ checkCount: -1 }, "nonnegative_counters"],
    ] as const) {
      await expect(challenge(data)).rejects.toThrow(constraint);
    }
  });

  it("requires verified proof before marking a challenge consumed", async () => {
    await expect(challenge({ consumedAt: new Date() })).rejects.toThrow("consumed_requires_verified");
    await expect(challenge({ verifiedAt: new Date(), consumedAt: new Date() })).resolves.toMatchObject({ sendCount: 0, checkCount: 0 });
  });

  it("permits exactly one concurrent verified-proof consumption transaction", async () => {
    const proof = await challenge({ verifiedAt: new Date() });
    const consume = () => db.$transaction(async (tx) => {
      const result = await tx.phoneVerificationChallenge.updateMany({ where: {
        id: proof.id, consumedAt: null, verifiedAt: { not: null }, expiresAt: { gt: new Date() },
      }, data: { consumedAt: new Date() } });
      if (!result.count) return false;
      await tx.user.create({ data: { email: proof.email, name: "Verified buyer", passwordHash: "test",
        phone: proof.phone, phoneVerifiedAt: proof.verifiedAt } });
      return true;
    });
    expect((await Promise.all([consume(), consume()])).sort()).toEqual([false, true]);
    expect(await db.user.count({ where: { email: proof.email } })).toBe(1);
  });

  it("rolls back proof consumption when account creation fails", async () => {
    const user = await makeUser();
    const proof = await challenge({ email: user.email, verifiedAt: new Date() });
    await expect(db.$transaction(async (tx) => {
      await tx.phoneVerificationChallenge.update({ where: { id: proof.id }, data: { consumedAt: new Date() } });
      await tx.user.create({ data: { email: user.email, name: "Duplicate", passwordHash: "test" } });
    })).rejects.toThrow();
    expect((await db.phoneVerificationChallenge.findUniqueOrThrow({ where: { id: proof.id } })).consumedAt).toBeNull();
  });
});
