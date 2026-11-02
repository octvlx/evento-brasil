// Gestão de senhas: troca em Minha conta (senha atual obrigatória, outras sessões
// encerradas, aviso por e-mail), redefinição sem reutilizar a senha anterior e
// validação no servidor do cadastro.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, resolveSession } from "@/server/auth/sessions";
import { PASSWORD_MESSAGES } from "@/lib/password-policy";
import { requestPasswordReset, resetPassword } from "@/server/services/password-reset";
import { changePassword, registerUser } from "@/server/services/users";
import * as outbox from "@/server/email/outbox";
import { db, makeUser, resetDb } from "../support/fixtures";

const CURRENT = "Atual#Segura2468";
const NEXT = "Nova#Firme13579";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

async function account() {
  const user = await makeUser();
  return db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(CURRENT) } });
}
const input = (over: Partial<{ currentPassword: string; newPassword: string; confirmPassword: string }> = {}) => ({ currentPassword: CURRENT, newPassword: NEXT, confirmPassword: NEXT, ...over });
const hashOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } })).passwordHash;

describe("alterar senha em Minha conta", () => {
  it("troca a senha, mantém a sessão atual, encerra as outras, invalida links de redefinição e avisa por e-mail", async () => {
    const user = await account();
    const current = await createSession(db, user.id);
    const other = await createSession(db, user.id);
    await requestPasswordReset(db, user.email, { ip: "198.51.100.1" });

    expect(await changePassword(db, user, input(), current.token)).toEqual({ otherSessionsRevoked: 1 });
    expect(await verifyPassword(NEXT, await hashOf(user.id))).toBe(true);
    expect(await resolveSession(db, current.token)).not.toBeNull();
    expect(await resolveSession(db, other.token)).toBeNull();
    expect(await db.passwordResetToken.count({ where: { userId: user.id, expiresAt: { gt: new Date() } } })).toBe(0);
    expect(await db.emailOutbox.count({ where: { template: "PASSWORD_CHANGED", recipient: user.email } })).toBe(1);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "user.password_changed", entityId: user.id } });
    expect(JSON.stringify(log)).not.toContain(NEXT);
  });

  it("senha atual errada, nova igual à atual ou confirmação diferente: nada muda", async () => {
    const user = await account();
    const s = await createSession(db, user.id);
    const before = await hashOf(user.id);
    await expect(changePassword(db, user, input({ currentPassword: "Errada#123456" }), s.token)).rejects.toThrow("A senha atual está incorreta.");
    await expect(changePassword(db, user, input({ newPassword: CURRENT, confirmPassword: CURRENT }), s.token)).rejects.toThrow(PASSWORD_MESSAGES.sameAsCurrent);
    await expect(changePassword(db, user, input({ confirmPassword: "Outra#Coisa999" }), s.token)).rejects.toThrow(PASSWORD_MESSAGES.newMismatch);
    await expect(changePassword(db, user, input({ newPassword: "fraca", confirmPassword: "fraca" }), s.token)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await hashOf(user.id)).toBe(before);
    expect(await resolveSession(db, s.token)).not.toBeNull();
    expect(await db.emailOutbox.count({ where: { template: "PASSWORD_CHANGED" } })).toBe(0);
  });

  it("duas trocas simultâneas com a mesma senha atual: só uma vale", async () => {
    const user = await account();
    const results = await Promise.allSettled([
      changePassword(db, user, input({ newPassword: "Primeira#Troca11", confirmPassword: "Primeira#Troca11" }), null),
      changePassword(db, user, input({ newPassword: "Segunda#Troca22", confirmPassword: "Segunda#Troca22" }), null),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "user.password_changed", entityId: user.id } })).toBe(1);
  });

  it("conta do Google não tem senha local para trocar", async () => {
    const user = await db.user.update({ where: { id: (await makeUser()).id }, data: { googleSubject: "google-1" } });
    await expect(changePassword(db, user, input(), null)).rejects.toThrow("Você utiliza o Google para acessar sua conta.");
  });
});

describe("redefinição: não reutiliza a senha anterior", () => {
  it("recusa a senha atual sem consumir o token; depois aceita outra e avisa por e-mail", async () => {
    const user = await account();
    const queue = vi.spyOn(outbox, "enqueueEmail");
    await requestPasswordReset(db, user.email, { ip: "198.51.100.2" });
    const url = new URL(queue.mock.calls.at(-1)![1].message!.text.match(/https?:\/\/[^\s<"]+/)![0]);
    const token = new URLSearchParams(url.hash.slice(1)).get("token")!;

    await expect(resetPassword(db, { token, password: CURRENT, confirmation: CURRENT })).rejects.toThrow(PASSWORD_MESSAGES.sameAsPrevious);
    await expect(resetPassword(db, { token, password: NEXT, confirmation: "Diferente#1234" })).rejects.toThrow(PASSWORD_MESSAGES.mismatch);
    expect((await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } })).consumedAt).toBeNull();

    expect(await resetPassword(db, { token, password: NEXT, confirmation: NEXT })).toEqual({ reset: true });
    expect(await verifyPassword(NEXT, await hashOf(user.id))).toBe(true);
    const notice = queue.mock.calls.find((c) => c[1].template === "PASSWORD_CHANGED")![1];
    expect(notice.message!.subject).toBe("Evento Brasil — Sua senha foi redefinida");
    expect(notice.message!.text).not.toContain(NEXT);
    expect(notice.message!.text).not.toContain(token);
  });
});

describe("cadastro valida a senha no servidor", () => {
  const base = { name: "Bia", email: "bia@test.local", confirmEmail: "bia@test.local", acceptTerms: true as const, acceptPrivacy: true as const };
  it("recusa senha fraca, comum, confirmação diferente ou e-mail redigitado diferente, mesmo sem passar pelo formulário", async () => {
    await expect(registerUser(db, { ...base, password: "12345678", confirmPassword: "12345678" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(registerUser(db, { ...base, password: "Senha@123", confirmPassword: "Senha@123" })).rejects.toThrow(PASSWORD_MESSAGES.common);
    await expect(registerUser(db, { ...base, password: NEXT, confirmPassword: "Outra#Coisa999" })).rejects.toThrow(PASSWORD_MESSAGES.mismatch);
    await expect(registerUser(db, { ...base, confirmEmail: "bia@test.locla", password: NEXT, confirmPassword: NEXT })).rejects.toThrow("Os e-mails não coincidem.");
    expect(await db.user.count({ where: { email: base.email } })).toBe(0);
    // Maiúsculas e espaços não contam como diferença.
    await registerUser(db, { ...base, confirmEmail: "  BIA@test.local ", password: NEXT, confirmPassword: NEXT });
    expect(await db.user.count({ where: { email: base.email } })).toBe(1);
  });
});
