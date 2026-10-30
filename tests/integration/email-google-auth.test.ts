import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeUser, resetDb } from "../support/fixtures";
import { requestEmailVerification, confirmEmailVerification, internalReturnPath } from "@/server/services/email-verification";
import { hashToken } from "@/server/crypto";
import { findGoogleUser, sealGoogleCookie } from "@/server/auth/google";
import { registerGoogleUser } from "@/server/services/google-registration";
import type { EmailMessage } from "@/server/email";
beforeEach(resetDb);
const mailer = () => { const messages: EmailMessage[] = []; return { id: "test-only", messages, send: vi.fn(async (m: EmailMessage) => { messages.push(m); }) }; };
const proofToken = (message: EmailMessage) => new URLSearchParams(new URL(message.text.match(/https?:\/\/\S+/)![0].replace(/\.$/, "")).hash.slice(1)).get("token")!;
describe("email confirmation", () => {
  it("stores only a hashed proof and consumes once without issuing a session", async () => {
    const user = await makeUser(); const mail = mailer(); await requestEmailVerification(db, user, "/checkout/revisao/cart", mail);
    const token = proofToken(mail.messages[0]); const record = await db.emailVerificationToken.findFirstOrThrow();
    expect(record.tokenHash).toBe(hashToken(token)); expect(record.tokenHash).not.toBe(token);
    expect(new URL(mail.messages[0].text.match(/https?:\/\/\S+/)![0]).searchParams.get("next")).toBe("/checkout/revisao/cart");
    const results = await Promise.allSettled([confirmEmailVerification(db, token), confirmEmailVerification(db, token)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();
    expect(await db.session.count()).toBe(0);
  });
  it("rejects expired proof and serializes resend spend", async () => {
    const user = await makeUser(); const mail = mailer();
    const results = await Promise.allSettled([requestEmailVerification(db, user, "/", mail), requestEmailVerification(db, user, "/", mail)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(mail.send).toHaveBeenCalledTimes(1);
    await db.emailVerificationToken.updateMany({ data: { createdAt: new Date(-1000), expiresAt: new Date(0) } });
    await expect(confirmEmailVerification(db, proofToken(mail.messages[0]))).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
  });
  it("invalidates an older link on resend and enforces durable hourly limits", async () => {
    const user = await makeUser(); const mail = mailer(); await requestEmailVerification(db, user, "/", mail);
    const first = proofToken(mail.messages[0]); await db.emailVerificationToken.updateMany({ data: { createdAt: new Date(Date.now() - 31_000) } });
    await requestEmailVerification(db, user, "/", mail); await expect(confirmEmailVerification(db, first)).rejects.toMatchObject({ code: "VALIDATION" });
    for (let i=0; i<3; i++) { await db.emailVerificationToken.updateMany({ data: { createdAt: new Date(Date.now() - 31_000) } }); await requestEmailVerification(db, user, "/", mail); }
    await db.emailVerificationToken.updateMany({ data: { createdAt: new Date(Date.now() - 31_000) } });
    await expect(requestEmailVerification(db, user, "/", mail)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(mail.send).toHaveBeenCalledTimes(5);
  });
  it("sanitizes delivery errors and rejects unsafe return paths", async () => {
    const mail = mailer(); mail.send.mockRejectedValue(new Error("sensitive provider body"));
    await expect(requestEmailVerification(db, await makeUser(), "/", mail)).rejects.toMatchObject({ code: "PROVIDER_ERROR", message: "Não foi possível enviar o e-mail. Solicite um novo envio em alguns instantes." });
    for (const next of ["https://evil.example", "//evil.example", "/\n/evil.example", "/\\evil.example"]) expect(internalReturnPath(next)).toBe("/");
  });
});
describe("Google accounts", () => {
  const identity = { subject: "google-subject-new", email: "google@test.local", name: "Pessoa Google", next: "/checkout/revisao/cart" };
  it("requires the encrypted Google proof plus explicit terms and privacy before creating a verified account", async () => {
    const pending = sealGoogleCookie("pending", identity);
    await expect(registerGoogleUser(db, pending, false, true)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.user.count()).toBe(0);
    const { user, next } = await registerGoogleUser(db, pending, true, true);
    expect(user.emailVerifiedAt).not.toBeNull(); expect(user.googleSubject).toBe(identity.subject); expect(next).toBe(identity.next);
    expect(await db.session.count()).toBe(0);
    await expect(registerGoogleUser(db, pending, true, true)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("never auto-links an existing password account by matching email", async () => {
    await makeUser({ email: identity.email });
    await expect(findGoogleUser(db, identity.subject, identity.email)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.user.findUniqueOrThrow({ where: { email: identity.email } })).googleSubject).toBeNull();
  });
  it("recognizes only the linked subject and rejects suspended Google users", async () => {
    const { user } = await registerGoogleUser(db, sealGoogleCookie("pending", identity), true, true);
    expect((await findGoogleUser(db, identity.subject, identity.email))?.id).toBe(user.id);
    await db.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    await expect(findGoogleUser(db, identity.subject, identity.email)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
