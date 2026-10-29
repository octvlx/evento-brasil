import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "../support/fixtures";
import { startSignupPhoneVerification as start, verifySignupPhoneVerification as verify, consumeSignupPhoneVerification as consume, cleanupSignupPhoneChallenges as cleanup } from "@/server/services/phone-verification";
import { registerUser, updateProfile } from "@/server/services/users";
const identity = { email: "signup@test.local", phone: "11999998888", smsConsent: true as const };
const details = { ...identity, name: "Comprador Teste", password: "password123", acceptTerms: true as const, acceptPrivacy: true as const };
const provider = () => ({ start: vi.fn(async () => `VE${"a".repeat(32)}`), check: vi.fn(async (_sid: string, _phone: string, code: string) => code === "123456") });
beforeEach(resetDb);
describe("verified phone signup", () => {
  it("requires verified proof and consumes it atomically under concurrency", async () => {
    const p = provider(); const c = await start(db, identity, {}, p);
    await expect(registerUser(db, { ...details, phoneVerificationToken: c.challengeToken })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.user.count()).toBe(0);
    await verify(db, { ...identity, challengeToken: c.challengeToken, code: "123456" }, {}, p);
    const results = await Promise.allSettled([registerUser(db, { ...details, phoneVerificationToken: c.challengeToken }), registerUser(db, { ...details, phoneVerificationToken: c.challengeToken })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const user = await db.user.findUniqueOrThrow({ where: { email: identity.email } });
    expect(user.phone).toBe("+5511999998888"); expect(user.phoneVerifiedAt).not.toBeNull();
    await expect(db.$transaction(tx => consume(tx, { ...identity, phoneVerificationToken: c.challengeToken }))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.session.count()).toBe(0);
    expect((await updateProfile(db, user, { name: user.name, phone: "(11) 99999-8888" })).phoneVerifiedAt).not.toBeNull();
    expect((await updateProfile(db, user, { name: user.name, phone: "21999998888" })).phoneVerifiedAt).toBeNull();
  });
  it("rejects mismatched identities and expires verified proof", async () => {
    const p = provider(); const c = await start(db, identity, {}, p);
    await expect(verify(db, { ...identity, email: "other@test.local", challengeToken: c.challengeToken, code: "123456" }, {}, p)).rejects.toMatchObject({ code: "VALIDATION" });
    await verify(db, { ...identity, challengeToken: c.challengeToken, code: "123456" }, {}, p);
    await expect(db.$transaction(tx => consume(tx, { ...identity, phone: "21999998888", phoneVerificationToken: c.challengeToken }))).rejects.toMatchObject({ code: "VALIDATION" });
    await db.phoneVerificationChallenge.updateMany({ data: { expiresAt: new Date(0) } });
    await expect(registerUser(db, { ...details, phoneVerificationToken: c.challengeToken })).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("persists invalid attempts and prevents further provider checks", async () => {
    const p = provider(); const c = await start(db, identity, {}, p);
    for (let i = 0; i < 5; i++) await expect(verify(db, { ...identity, challengeToken: c.challengeToken, code: "000000" }, {}, p)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(verify(db, { ...identity, challengeToken: c.challengeToken, code: "123456" }, {}, p)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(p.check).toHaveBeenCalledTimes(5);
  });
  it("serializes competing sends before provider spend", async () => {
    const p = provider(); const results = await Promise.allSettled([start(db, identity, { ip: "one" }, p), start(db, identity, { ip: "two" }, p)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(p.start).toHaveBeenCalledTimes(1);
  });
  it("counts failed sends and requires SMS consent", async () => {
    const p = provider(); p.start.mockRejectedValue(new Error("failed"));
    await expect(start(db, identity, {}, p)).rejects.toThrow(); expect(await db.phoneVerificationChallenge.count()).toBe(1);
    await expect(start(db, identity, {}, p)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(start(db, { ...identity, smsConsent: false as unknown as true }, {}, p)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

// Seed independent expired challenges to prove rotation/expiry does not reset accounting.
async function seedAttempts(count: number, ageMs: number, samePhone = true) {
  const p = provider();
  await start(db, identity, { ip: "accounting-client" }, p);
  const sample = await db.phoneVerificationChallenge.findFirstOrThrow();
  await db.phoneVerificationChallenge.deleteMany();
  const createdAt = new Date(Date.now() - ageMs);
  await db.phoneVerificationChallenge.createMany({ data: Array.from({ length: count }, (_, index) => ({
    tokenHash: createHash("sha256").update(`accounting-${index}`).digest("hex"),
    email: `rotated-${index}@test.local`,
    phone: samePhone ? sample.phone : `+551199999${String(index).padStart(4, "0")}`,
    clientKeyHash: sample.clientKeyHash,
    smsConsentAt: createdAt, createdAt, lastSentAt: createdAt,
    expiresAt: new Date(createdAt.getTime() + 10 * 60_000), sendCount: 1,
  })) });
  p.start.mockClear();
  return p;
}

describe("durable signup SMS accounting and retention", () => {
  it.each([
    { name: "hourly phone", count: 5, age: 10 * 60_000, samePhone: true, ip: "new-client" },
    { name: "daily phone", count: 10, age: 2 * 3_600_000, samePhone: true, ip: "new-client" },
    { name: "hourly client", count: 20, age: 10 * 60_000, samePhone: false, ip: "accounting-client" },
    { name: "daily client", count: 100, age: 2 * 3_600_000, samePhone: false, ip: "accounting-client" },
  ])("enforces $name limits across expired challenges and rotated emails", async ({ count, age, samePhone, ip }) => {
    const p = await seedAttempts(count, age, samePhone);
    await expect(start(db, identity, { ip }, p)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(p.start).not.toHaveBeenCalled();
    expect(await db.phoneVerificationChallenge.count()).toBe(count);
  });

  it("cleanup preserves the rolling rate window and only removes old expired PII", async () => {
    const p = await seedAttempts(10, 2 * 3_600_000);
    const recent = await db.phoneVerificationChallenge.findFirstOrThrow();
    await db.phoneVerificationChallenge.create({ data: {
      tokenHash: createHash("sha256").update("old-expired").digest("hex"), email: "old@test.local", phone: recent.phone,
      clientKeyHash: recent.clientKeyHash, smsConsentAt: new Date(0), createdAt: new Date(Date.now() - 25 * 3_600_000), expiresAt: new Date(0),
    } });
    expect((await cleanup(db)).count).toBe(1);
    expect(await db.phoneVerificationChallenge.count()).toBe(10);
    await expect(start(db, identity, { ip: "new-client" }, p)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(p.start).not.toHaveBeenCalled();
    expect((await cleanup(db, new Date(Date.now() + 25 * 3_600_000))).count).toBe(10);
    expect(await db.phoneVerificationChallenge.count()).toBe(0);
  });

  it("preserves successful SMS consent audit evidence after signup challenge cleanup", async () => {
    const p = provider(); const challenge = await start(db, identity, {}, p);
    const proof = await db.phoneVerificationChallenge.findFirstOrThrow();
    await verify(db, { ...identity, challengeToken: challenge.challengeToken, code: "123456" }, {}, p);
    const user = await registerUser(db, { ...details, phoneVerificationToken: challenge.challengeToken });
    const before = await db.auditLog.findFirstOrThrow({ where: { actorUserId: user.id, action: "user.registered" } });
    expect(before.metadata).toMatchObject({ smsConsentAt: proof.smsConsentAt.toISOString(), smsConsentPurpose: "signup-security-sms@1" });
    expect((await cleanup(db, new Date(Date.now() + 25 * 3_600_000))).count).toBe(1);
    const after = await db.auditLog.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.metadata).toEqual(before.metadata);
    expect(await db.phoneVerificationChallenge.count()).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).phoneVerifiedAt).not.toBeNull();
  });
});
