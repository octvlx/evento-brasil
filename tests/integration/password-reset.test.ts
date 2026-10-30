import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeUser, resetDb } from "../support/fixtures";
import { PASSWORD_RESET_MESSAGE, requestPasswordReset, resetPassword } from "@/server/services/password-reset";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, resolveSession } from "@/server/auth/sessions";
import { hashToken } from "@/server/crypto";
import * as outbox from "@/server/email/outbox";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

async function account() {
  const user = await makeUser();
  return db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword("old-password-123") } });
}

async function requestProof(email: string, ip = "198.51.100.10") {
  const queue = vi.spyOn(outbox, "enqueueEmail");
  const result = await requestPasswordReset(db, email, { ip });
  expect(result).toEqual({ message: PASSWORD_RESET_MESSAGE });
  const message = queue.mock.calls.at(-1)?.[1].message;
  expect(message).toBeDefined();
  const url = new URL(message!.text.match(/https?:\/\/[^\s<"]+/)![0]);
  expect(url.pathname).toBe("/redefinir-senha");
  expect(url.searchParams.get("token")).toBeNull();
  const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return token;
}

describe("password recovery", () => {
  it("stores hashed expiring proof, uses it once and revokes all old sessions without verifying email", async () => {
    const user = await account();
    const session = await createSession(db, user.id);
    const token = await requestProof(user.email);
    const record = await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(record.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(record)).not.toContain(token);
    expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBeGreaterThan(29 * 60_000);
    expect(record.expiresAt.getTime() - record.createdAt.getTime()).toBeLessThanOrEqual(30 * 60_000);
    expect(await resetPassword(db, { token, password: "new-password-456" })).toEqual({ reset: true });
    const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("new-password-456", updated.passwordHash)).toBe(true);
    expect(await verifyPassword("old-password-123", updated.passwordHash)).toBe(false);
    expect(updated.emailVerifiedAt).toBeNull();
    expect(await resolveSession(db, session.token)).toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    await expect(resetPassword(db, { token, password: "other-password-789" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.auditLog.count({ where: { actorUserId: user.id, action: "user.password_reset" } })).toBe(1);
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(token);
  });

  it("serializes simultaneous resets so exactly one password mutation succeeds", async () => {
    const user = await account();
    const token = await requestProof(user.email);
    const results = await Promise.allSettled([
      resetPassword(db, { token, password: "concurrent-password-one" }),
      resetPassword(db, { token, password: "concurrent-password-two" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.auditLog.count({ where: { actorUserId: user.id, action: "user.password_reset" } })).toBe(1);
  });

  it("rejects expired and malformed proofs and enforces the existing password policy", async () => {
    const user = await account();
    const token = await requestProof(user.email);
    await expect(resetPassword(db, { token, password: "short" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await db.passwordResetToken.findFirstOrThrow()).consumedAt).toBeNull();
    await db.passwordResetToken.updateMany({ data: { createdAt: new Date(-1000), expiresAt: new Date(0) } });
    await expect(resetPassword(db, { token, password: "new-password-123" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(resetPassword(db, { token: "invalid", password: "new-password-123" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await verifyPassword("old-password-123", (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });

  it("returns the same response for unknown, Google-only and suspended accounts without creating proofs", async () => {
    const google = await makeUser();
    await db.user.update({ where: { id: google.id }, data: { googleSubject: "trusted-google-subject" } });
    const suspended = await account();
    await db.user.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });
    const queue = vi.spyOn(outbox, "enqueueEmail");
    for (const email of ["unknown@example.test", google.email, suspended.email, "bad-address"]) {
      expect(await requestPasswordReset(db, email, { ip: "203.0.113.7" })).toEqual({ message: PASSWORD_RESET_MESSAGE });
    }
    expect(queue).not.toHaveBeenCalled();
    expect(await db.passwordResetToken.count()).toBe(0);
  });

  it("throttles concurrent repeated requests without revealing account existence", async () => {
    const user = await account();
    const results = await Promise.all(Array.from({ length: 4 }, () => requestPasswordReset(db, user.email, { ip: "203.0.113.8" })));
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ message: PASSWORD_RESET_MESSAGE })));
    expect(await db.passwordResetToken.count()).toBe(1);
  });

  it("invalidates prior proofs on resend and refuses a suspended account at consumption time", async () => {
    const user = await account();
    const first = await requestProof(user.email);
    // Advance only the cooldown dependency; hourly persistence remains exercised elsewhere.
    vi.spyOn(outbox, "consumeEmailRateLimit").mockResolvedValue(undefined);
    const second = await requestProof(user.email);
    await expect(resetPassword(db, { token: first, password: "first-password-123" })).rejects.toMatchObject({ code: "VALIDATION" });
    await db.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    await expect(resetPassword(db, { token: second, password: "second-password-123" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
