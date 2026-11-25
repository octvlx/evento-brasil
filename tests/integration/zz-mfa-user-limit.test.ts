// 2FA no login: além do limite por sessão pendente (MAX_MFA_ATTEMPTS), um teto por
// usuário somando todas as sessões. Sem ele, quem tem a senha repetiria
// login → 4 códigos → novo login sem fim.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/server/auth/sessions";
import { totpCode, totpStep } from "@/server/auth/totp";
import { hashToken } from "@/server/crypto";
import {
  completeMfaLogin,
  confirmTotpEnrollment,
  MAX_MFA_ATTEMPTS,
  MAX_MFA_USER_ATTEMPTS,
  MFA_USER_WINDOW_MS,
  startTotpEnrollment,
} from "@/server/services/two-factor";
import { db, makeUser, resetDb } from "../support/fixtures";

const T0 = new Date("2026-11-24T12:00:00.000Z");
const codeAt = (secret: string, when: Date) => totpCode(secret, totpStep(when));

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

async function enrolled() {
  const user = await makeUser();
  const { secret } = await startTotpEnrollment(db, user.id, T0);
  await confirmTotpEnrollment(db, user.id, codeAt(secret, T0), null, T0);
  return { user, secret };
}

/** Códigos errados espalhados por logins novos, sempre abaixo do limite por sessão. */
async function wrongCodes(userId: string, total: number) {
  let session = await createSession(db, userId);
  let inSession = 0;
  for (let i = 0; i < total; i++) {
    if (inSession === MAX_MFA_ATTEMPTS - 1) {
      session = await createSession(db, userId);
      inSession = 0;
    }
    await expect(completeMfaLogin(db, session.token, "000000", new Date())).rejects.toMatchObject({ code: "VALIDATION" });
    inSession++;
  }
}

describe("teto de tentativas de 2FA por usuário", () => {
  it("renovar o login não dá tentativas novas: passado o teto nem o código certo vale", async () => {
    const { user, secret } = await enrolled();
    await wrongCodes(user.id, MAX_MFA_USER_ATTEMPTS);

    const s = await createSession(db, user.id);
    const when = new Date(T0.getTime() + 60_000);
    vi.setSystemTime(when);
    await expect(completeMfaLogin(db, s.token, codeAt(secret, when), when)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: expect.stringContaining("Entre novamente"),
    });
    expect(await db.session.findUnique({ where: { tokenHash: hashToken(s.token) } })).toBeNull();
    // Outro login no mesmo período também é recusado; auditoria só uma vez.
    const again = await createSession(db, user.id);
    await expect(completeMfaLogin(db, again.token, codeAt(secret, when), when)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await db.auditLog.count({ where: { action: "mfa.user_locked", entityId: user.id } })).toBe(1);

    // Passada a janela, o código certo volta a valer.
    const after = new Date(T0.getTime() + MFA_USER_WINDOW_MS + 60_000);
    vi.setSystemTime(after);
    const ok = await createSession(db, user.id);
    await expect(completeMfaLogin(db, ok.token, codeAt(secret, after), after)).resolves.toMatchObject({ userId: user.id });
  });

  it("acertar zera o contador do usuário", async () => {
    const { user, secret } = await enrolled();
    await wrongCodes(user.id, MAX_MFA_USER_ATTEMPTS - 1);
    const when = new Date(T0.getTime() + 60_000);
    vi.setSystemTime(when);
    const s = await createSession(db, user.id);
    await completeMfaLogin(db, s.token, codeAt(secret, when), when);
    // Depois do acerto, erros voltam a ser recusados como código errado, não bloqueio.
    await wrongCodes(user.id, MAX_MFA_USER_ATTEMPTS - 1);
  });

  it("o teto é por usuário: outra conta não é afetada", async () => {
    const victim = await enrolled();
    const other = await enrolled();
    await wrongCodes(victim.user.id, MAX_MFA_USER_ATTEMPTS);
    const when = new Date(T0.getTime() + 60_000);
    vi.setSystemTime(when);
    const s = await createSession(db, other.user.id);
    await expect(completeMfaLogin(db, s.token, codeAt(other.secret, when), when)).resolves.toMatchObject({ userId: other.user.id });
  });
});
