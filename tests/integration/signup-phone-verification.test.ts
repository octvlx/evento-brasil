import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "../support/fixtures";
import { startSignupPhoneVerification as start, verifySignupPhoneVerification as verify, consumeSignupPhoneVerification as consume } from "@/server/services/phone-verification";
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
