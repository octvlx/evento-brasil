// Verificação em duas etapas (TOTP) para administradores e donos de organização:
// ativação, login em duas etapas, códigos de recuperação, bloqueio por tentativas,
// reuso de código e exigência nas verificações centrais de permissão.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertOrgPermission, assertPlatformAdmin } from "@/server/auth/permissions";
import { hashPassword } from "@/server/auth/password";
import { createSession, resolveSession, SESSION_TTL_MS } from "@/server/auth/sessions";
import { totpCode, totpStep } from "@/server/auth/totp";
import { hashToken } from "@/server/crypto";
import {
  adminResetTwoFactor,
  completeMfaLogin,
  confirmTotpEnrollment,
  disableTotp,
  MAX_MFA_ATTEMPTS,
  regenerateRecoveryCodes,
  startTotpEnrollment,
  twoFactorStatus,
} from "@/server/services/two-factor";
import { db, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(() => vi.unstubAllEnvs());

const T0 = new Date();
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const codeAt = (secret: string, when: Date) => totpCode(secret, totpStep(when));

/** Usuário com 2FA ativo (ativado em T0). Devolve o segredo e os códigos de recuperação. */
async function enrolled(opts: { admin?: boolean } = {}) {
  const user = await makeUser(opts);
  const { secret } = await startTotpEnrollment(db, user.id, T0);
  const { recoveryCodes } = await confirmTotpEnrollment(db, user.id, codeAt(secret, T0), null, T0);
  return { user: await db.user.findUniqueOrThrow({ where: { id: user.id } }), secret, recoveryCodes };
}

describe("ativação", () => {
  it("segredo cifrado, código errado recusado, códigos de recuperação só em hash, outras sessões encerradas", async () => {
    const user = await makeUser();
    const keep = await createSession(db, user.id);
    const other = await createSession(db, user.id);
    const { secret, qrDataUrl } = await startTotpEnrollment(db, user.id, T0);
    expect(qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const pending = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(pending.totpPendingSecretEncrypted).toMatch(/^v1\./);
    expect(pending.totpPendingSecretEncrypted).not.toContain(secret);
    expect(pending.totpEnabledAt).toBeNull();

    await expect(confirmTotpEnrollment(db, user.id, "000000", keep.token, T0)).rejects.toMatchObject({ code: "VALIDATION" });
    const { recoveryCodes } = await confirmTotpEnrollment(db, user.id, codeAt(secret, T0), keep.token, T0);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    const stored = await db.totpRecoveryCode.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(10);
    expect(stored.some((r) => recoveryCodes.some((c) => r.codeHash.includes(c)))).toBe(false);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.totpEnabledAt).not.toBeNull();
    expect(after.totpSecretEncrypted).toMatch(/^v1\./);
    expect(after.totpPendingSecretEncrypted).toBeNull();
    // A sessão de quem ativou continua; as outras são encerradas.
    expect(await db.session.count({ where: { tokenHash: hashToken(keep.token) } })).toBe(1);
    expect(await db.session.count({ where: { tokenHash: hashToken(other.token) } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "mfa.enabled", entityId: user.id } })).toBe(1);
    await expect(startTotpEnrollment(db, user.id, T0)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("a configuração expira em 15 minutos", async () => {
    const user = await makeUser();
    const { secret } = await startTotpEnrollment(db, user.id, T0);
    const late = later(16 * 60);
    await expect(confirmTotpEnrollment(db, user.id, codeAt(secret, late), null, late)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("login em duas etapas", () => {
  it("com 2FA ativo a sessão nasce pendente e não autentica até o código", async () => {
    const { user, secret } = await enrolled();
    const s = await createSession(db, user.id);
    expect(s.mfaPending).toBe(true);
    expect(s.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(await resolveSession(db, s.token)).toBeNull();
    expect((await resolveSession(db, s.token, { allowMfaPending: true }))?.mfaPending).toBe(true);

    const when = later(60);
    await completeMfaLogin(db, s.token, codeAt(secret, when), when);
    const session = await resolveSession(db, s.token);
    expect(session?.user.id).toBe(user.id);
    expect(session!.expiresAt.getTime()).toBeGreaterThan(when.getTime() + SESSION_TTL_MS - 60_000);
  });

  it("sem 2FA a sessão é normal (comprador comum não muda nada)", async () => {
    const user = await makeUser();
    const s = await createSession(db, user.id);
    expect(s.mfaPending).toBe(false);
    expect(await resolveSession(db, s.token)).not.toBeNull();
  });

  it("o mesmo código não vale duas vezes, nem em logins simultâneos", async () => {
    const { user, secret } = await enrolled();
    const [a, b] = [await createSession(db, user.id), await createSession(db, user.id)];
    const when = later(90);
    const code = codeAt(secret, when);
    const results = await Promise.allSettled([completeMfaLogin(db, a.token, code, when), completeMfaLogin(db, b.token, code, when)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const c = await createSession(db, user.id);
    await expect(completeMfaLogin(db, c.token, code, when)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("código de recuperação vale uma única vez e fica auditado", async () => {
    const { user, recoveryCodes } = await enrolled();
    const first = await createSession(db, user.id);
    // Tolerante a minúsculas e sem hífen.
    const r = await completeMfaLogin(db, first.token, recoveryCodes[0].toLowerCase().replace("-", ""), later(30));
    expect(r.usedRecoveryCode).toBe(true);
    const again = await createSession(db, user.id);
    await expect(completeMfaLogin(db, again.token, recoveryCodes[0], later(31))).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await twoFactorStatus(db, user.id)).recoveryCodesRemaining).toBe(9);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "mfa.recovery_code_used", entityId: user.id } });
    expect(log.metadata).toMatchObject({ remaining: 9 });
  });

  it(`${MAX_MFA_ATTEMPTS} códigos errados apagam a sessão pendente`, async () => {
    const { user } = await enrolled();
    const s = await createSession(db, user.id);
    for (let i = 1; i < MAX_MFA_ATTEMPTS; i++)
      await expect(completeMfaLogin(db, s.token, "000000", later(30))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(completeMfaLogin(db, s.token, "000000", later(30))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await db.session.count({ where: { tokenHash: hashToken(s.token) } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "mfa.login_locked", entityId: user.id } })).toBe(1);
  });

  it("sessão pendente expirada ou já verificada não aceita código", async () => {
    const { user, secret } = await enrolled();
    const s = await createSession(db, user.id);
    const tooLate = later(11 * 60);
    await expect(completeMfaLogin(db, s.token, codeAt(secret, tooLate), tooLate)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const ok = await createSession(db, user.id);
    await completeMfaLogin(db, ok.token, codeAt(secret, later(60)), later(60));
    await expect(completeMfaLogin(db, ok.token, codeAt(secret, later(120)), later(120))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("exigência para admin e dono de organização (MFA_REQUIRED)", () => {
  it("admin sem 2FA é barrado em assertPlatformAdmin; com 2FA passa", async () => {
    vi.stubEnv("MFA_REQUIRED", "true");
    const admin = await makeUser({ admin: true });
    expect(() => assertPlatformAdmin(admin)).toThrow(expect.objectContaining({ code: "MFA_REQUIRED" }));
    const { user } = await enrolled({ admin: true });
    expect(() => assertPlatformAdmin(user)).not.toThrow();
  });

  it("dono sem 2FA é barrado em qualquer permissão da organização; outros papéis não", async () => {
    vi.stubEnv("MFA_REQUIRED", "true");
    const owner = await makeUser();
    const manager = await makeUser();
    const org = await makeOrg(owner, { extraMembers: [{ userId: manager.id, role: "EVENT_MANAGER" }] });
    await expect(assertOrgPermission(db, owner, org.id, "org:read")).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    await expect(assertOrgPermission(db, manager, org.id, "event:write")).resolves.toBeDefined();

    const { secret } = await startTotpEnrollment(db, owner.id, T0);
    await confirmTotpEnrollment(db, owner.id, codeAt(secret, T0), null, T0);
    const fresh = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    await expect(assertOrgPermission(db, fresh, org.id, "finance:read")).resolves.toBeDefined();
  });

  it("sem MFA_REQUIRED (desenvolvimento e testes) nada muda para admin e dono", async () => {
    vi.stubEnv("MFA_REQUIRED", "false");
    const admin = await makeUser({ admin: true });
    expect(() => assertPlatformAdmin(admin)).not.toThrow();
  });

  it("dono obrigado não consegue desativar; usuário comum desativa com senha e código", async () => {
    vi.stubEnv("MFA_REQUIRED", "true");
    const owner = await enrolled();
    await makeOrg(owner.user);
    await expect(disableTotp(db, owner.user.id, { code: codeAt(owner.secret, later(60)), password: "x" }, later(60))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await twoFactorStatus(db, owner.user.id)).required).toBe(true);

    const buyer = await enrolled();
    await db.user.update({ where: { id: buyer.user.id }, data: { passwordHash: await hashPassword("Senha#Forte2468") } });
    await expect(disableTotp(db, buyer.user.id, { code: codeAt(buyer.secret, later(60)), password: "errada" }, later(60))).rejects.toMatchObject({ code: "VALIDATION" });
    await disableTotp(db, buyer.user.id, { code: codeAt(buyer.secret, later(90)), password: "Senha#Forte2468" }, later(90));
    const off = await db.user.findUniqueOrThrow({ where: { id: buyer.user.id } });
    expect(off.totpEnabledAt).toBeNull();
    expect(off.totpSecretEncrypted).toBeNull();
    expect(await db.totpRecoveryCode.count({ where: { userId: buyer.user.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "mfa.disabled", entityId: buyer.user.id } })).toBe(1);
  });

  it("gerar novos códigos invalida os antigos", async () => {
    const { user, secret, recoveryCodes } = await enrolled();
    const { recoveryCodes: fresh } = await regenerateRecoveryCodes(db, user.id, codeAt(secret, later(60)), later(60));
    expect(fresh).toHaveLength(10);
    const s = await createSession(db, user.id);
    await expect(completeMfaLogin(db, s.token, recoveryCodes[0], later(61))).rejects.toMatchObject({ code: "VALIDATION" });
    await completeMfaLogin(db, s.token, fresh[0], later(62));
  });
});

describe("redefinição do 2FA pelo admin (perdeu celular e códigos)", () => {
  const reason = "Perdeu o celular; identidade confirmada por e-mail";

  it("apaga 2FA e códigos, encerra as sessões, avisa por e-mail e audita com o motivo", async () => {
    vi.stubEnv("MFA_REQUIRED", "true");
    const admin = await enrolled({ admin: true });
    const target = await enrolled();
    const s1 = await createSession(db, target.user.id);
    const s2 = await createSession(db, target.user.id);
    const when = later(60);
    const result = await adminResetTwoFactor(db, admin.user, target.user.id, { adminCode: codeAt(admin.secret, when), reason }, when);
    expect(result.sessionsRevoked).toBe(2);

    const after = await db.user.findUniqueOrThrow({ where: { id: target.user.id } });
    expect(after).toMatchObject({ totpEnabledAt: null, totpSecretEncrypted: null, totpLastStep: null });
    expect(await db.totpRecoveryCode.count({ where: { userId: target.user.id } })).toBe(0);
    expect(await db.session.count({ where: { tokenHash: { in: [hashToken(s1.token), hashToken(s2.token)] } } })).toBe(0);
    const mail = await db.emailOutbox.findFirstOrThrow({ where: { template: "MFA_RESET" } });
    expect(mail.recipient).toBe(target.user.email);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "mfa.reset_by_admin", entityId: target.user.id } });
    expect(log.actorUserId).toBe(admin.user.id);
    expect(log.metadata).toMatchObject({ reason, sessionsRevoked: 2 });

    // A pessoa entra só com a senha (sessão normal) e ativa de novo no próximo acesso.
    const fresh = await createSession(db, target.user.id);
    expect(fresh.mfaPending).toBe(false);
    const { secret } = await startTotpEnrollment(db, target.user.id, later(120));
    await confirmTotpEnrollment(db, target.user.id, codeAt(secret, later(120)), fresh.token, later(120));
    expect((await twoFactorStatus(db, target.user.id)).enabled).toBe(true);
  });

  it("exige o código do próprio admin, válido e não reutilizado", async () => {
    const admin = await enrolled({ admin: true });
    const target = await enrolled();
    await expect(adminResetTwoFactor(db, admin.user, target.user.id, { adminCode: "000000", reason }, later(60))).rejects.toMatchObject({ code: "VALIDATION" });
    // Código da ativação do admin (passo já usado) não vale de novo.
    await expect(adminResetTwoFactor(db, admin.user, target.user.id, { adminCode: codeAt(admin.secret, T0), reason }, T0)).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await twoFactorStatus(db, target.user.id)).enabled).toBe(true);
  });

  it("recusa: admin sem 2FA, não admin, a própria conta, sem motivo, alvo sem 2FA, conta excluída", async () => {
    const target = await enrolled();
    const adminNo2fa = await makeUser({ admin: true });
    await expect(adminResetTwoFactor(db, adminNo2fa, target.user.id, { adminCode: "123456", reason })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const notAdmin = await enrolled();
    await expect(adminResetTwoFactor(db, notAdmin.user, target.user.id, { adminCode: codeAt(notAdmin.secret, later(60)), reason }, later(60))).rejects.toMatchObject({ code: "FORBIDDEN" });

    const admin = await enrolled({ admin: true });
    await expect(adminResetTwoFactor(db, admin.user, admin.user.id, { adminCode: codeAt(admin.secret, later(60)), reason }, later(60))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(adminResetTwoFactor(db, admin.user, target.user.id, { adminCode: codeAt(admin.secret, later(60)), reason: "  " }, later(60))).rejects.toMatchObject({ code: "VALIDATION" });

    const plain = await makeUser();
    await expect(adminResetTwoFactor(db, admin.user, plain.id, { adminCode: codeAt(admin.secret, later(90)), reason }, later(90))).rejects.toMatchObject({ code: "INVALID_STATE" });

    await db.user.update({ where: { id: target.user.id }, data: { anonymizedAt: new Date() } });
    await expect(adminResetTwoFactor(db, admin.user, target.user.id, { adminCode: codeAt(admin.secret, later(120)), reason }, later(120))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await db.auditLog.count({ where: { action: "mfa.reset_by_admin" } })).toBe(0);
  });
});
