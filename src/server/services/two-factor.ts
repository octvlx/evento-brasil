import "server-only";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import type { Db } from "../db";
import { TX_OPTIONS } from "../db";
import { audit } from "../audit";
import { decryptPII, encryptPII, hashToken } from "../crypto";
import { AppError, forbidden, invalidState } from "../errors";
import { verifyPassword } from "../auth/password";
import { mfaEnforced } from "../auth/mfa-policy";
import { SESSION_TTL_MS } from "../auth/sessions";
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from "../auth/totp";

// Verificação em duas etapas (TOTP) — obrigatória para administradores e donos
// de organização quando mfaEnforced(). Regras:
// - ativar exige confirmar um código do aplicativo; gera 10 códigos de recuperação
//   (mostrados uma vez; só o hash fica no banco) e encerra as outras sessões;
// - no login, a sessão fica pendente até um código válido (TOTP ou recuperação),
//   com até MAX_MFA_ATTEMPTS tentativas; um código TOTP não vale duas vezes;
// - desativar exige o código (e a senha, para conta com senha) e é recusado
//   enquanto a conta for obrigada a usar 2FA.

export const RECOVERY_CODE_COUNT = 10;
export const MAX_MFA_ATTEMPTS = 5;
/** Tempo para escanear o QR e confirmar o primeiro código. */
export const ENROLLMENT_TTL_MS = 15 * 60_000;

const wrongCode = () => new AppError("VALIDATION", "Código incorreto. Confira o aplicativo autenticador e tente de novo.");

/** Administrador da plataforma ou dono de alguma organização. */
export async function isMfaRequiredUser(db: Db, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
  if (!user) return false;
  if (user.platformRole === "ADMIN") return true;
  return (await db.organizationMember.count({ where: { userId, role: "OWNER" } })) > 0;
}

export async function twoFactorStatus(db: Db, userId: string) {
  const [user, remaining, privileged] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabledAt: true, googleSubject: true } }),
    db.totpRecoveryCode.count({ where: { userId, usedAt: null } }),
    isMfaRequiredUser(db, userId),
  ]);
  return {
    enabled: Boolean(user.totpEnabledAt),
    enabledAt: user.totpEnabledAt,
    recoveryCodesRemaining: remaining,
    /** Conta privilegiada: o 2FA é (ou será, em produção) obrigatório e não pode ser desligado. */
    privileged,
    required: privileged && mfaEnforced(),
    hasPassword: !user.googleSubject,
  };
}

/** Recuperação: 10 caracteres base32 em dois grupos (ex.: 7QK2M-XW4PA). */
function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");
const recoveryHash = (code: string) => hashToken(`totp-recovery:${normalizeRecoveryCode(code)}`);

/** Primeiro passo: gera o segredo (pendente) e o QR para o aplicativo. */
export async function startTotpEnrollment(db: Db, userId: string, now = new Date()) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, totpEnabledAt: true } });
  if (user.totpEnabledAt) throw invalidState("A verificação em duas etapas já está ativa.");
  const secret = generateTotpSecret();
  await db.user.update({ where: { id: userId }, data: { totpPendingSecretEncrypted: encryptPII(secret), totpPendingAt: now } });
  const uri = otpauthUri(secret, user.email);
  return { secret, uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

/**
 * Segundo passo: confere o código do aplicativo e ativa. Devolve os códigos de
 * recuperação em claro (única vez). Encerra as outras sessões da conta; a atual
 * (`keepSessionToken`) continua, já verificada.
 */
export async function confirmTotpEnrollment(db: Db, userId: string, code: string, keepSessionToken: string | null, now = new Date()) {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { totpEnabledAt: true, totpPendingSecretEncrypted: true, totpPendingAt: true },
  });
  if (user.totpEnabledAt) throw invalidState("A verificação em duas etapas já está ativa.");
  if (!user.totpPendingSecretEncrypted || !user.totpPendingAt || now.getTime() - user.totpPendingAt.getTime() > ENROLLMENT_TTL_MS)
    throw invalidState("A configuração expirou. Comece de novo para gerar outro QR code.");
  const step = verifyTotp(decryptPII(user.totpPendingSecretEncrypted), code, now);
  if (step === null) throw wrongCode();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const keepHash = keepSessionToken ? hashToken(keepSessionToken) : null;
  await db.$transaction(async (tx) => {
    // Condicional: duas confirmações simultâneas não ativam duas vezes.
    const done = await tx.user.updateMany({
      where: { id: userId, totpEnabledAt: null, totpPendingSecretEncrypted: user.totpPendingSecretEncrypted },
      data: {
        totpSecretEncrypted: user.totpPendingSecretEncrypted,
        totpEnabledAt: now,
        totpLastStep: step,
        totpPendingSecretEncrypted: null,
        totpPendingAt: null,
      },
    });
    if (done.count !== 1) throw invalidState("A verificação em duas etapas já está ativa.");
    await tx.totpRecoveryCode.deleteMany({ where: { userId } });
    await tx.totpRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: recoveryHash(c) })) });
    const revoked = await tx.session.deleteMany({ where: { userId, ...(keepHash ? { NOT: { tokenHash: keepHash } } : {}) } });
    await audit(tx, { actorUserId: userId, action: "mfa.enabled", entityType: "User", entityId: userId, metadata: { method: "totp", otherSessionsRevoked: revoked.count } });
  }, TX_OPTIONS);
  return { recoveryCodes: codes };
}

/**
 * Login, segunda etapa: aceita um código do aplicativo ou um de recuperação.
 * Sucesso → a sessão pendente vira sessão normal (prazo cheio). Erros contam
 * tentativas; na última a sessão é apagada e é preciso digitar a senha de novo.
 */
export async function completeMfaLogin(db: Db, sessionToken: string, code: string, now = new Date()) {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(sessionToken) },
    select: { id: true, userId: true, mfaPending: true, mfaAttempts: true, expiresAt: true, user: { select: { status: true, totpSecretEncrypted: true, totpEnabledAt: true, totpLastStep: true } } },
  });
  const expired = () => new AppError("UNAUTHENTICATED", "A verificação expirou. Entre novamente com e-mail e senha.");
  if (!session || !session.mfaPending || session.expiresAt <= now || session.user.status !== "ACTIVE") throw expired();
  if (!session.user.totpEnabledAt || !session.user.totpSecretEncrypted) {
    // 2FA desligado no meio do caminho: a senha já foi conferida, libera.
    await db.session.update({ where: { id: session.id }, data: { mfaPending: false, mfaAttempts: 0, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) } });
    return { userId: session.userId, usedRecoveryCode: false };
  }

  let accepted = false;
  let usedRecoveryCode = false;
  const step = verifyTotp(decryptPII(session.user.totpSecretEncrypted), code, now, session.user.totpLastStep);
  if (step !== null) {
    // Só um uso por passo, mesmo com dois logins simultâneos com o mesmo código.
    const claimed = await db.user.updateMany({
      where: { id: session.userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    accepted = claimed.count === 1;
  } else if (normalizeRecoveryCode(code).length === 10) {
    const used = await db.totpRecoveryCode.updateMany({
      where: { userId: session.userId, codeHash: recoveryHash(code), usedAt: null },
      data: { usedAt: now },
    });
    accepted = usedRecoveryCode = used.count === 1;
  }

  if (!accepted) {
    const attempts = session.mfaAttempts + 1;
    if (attempts >= MAX_MFA_ATTEMPTS) {
      await db.session.deleteMany({ where: { id: session.id } });
      await audit(db, { actorUserId: session.userId, action: "mfa.login_locked", entityType: "User", entityId: session.userId, metadata: { attempts } });
      throw new AppError("RATE_LIMITED", "Muitas tentativas com código incorreto. Entre novamente com e-mail e senha.");
    }
    await db.session.update({ where: { id: session.id }, data: { mfaAttempts: attempts } });
    throw wrongCode();
  }

  await db.session.update({ where: { id: session.id }, data: { mfaPending: false, mfaAttempts: 0, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) } });
  if (usedRecoveryCode) {
    const remaining = await db.totpRecoveryCode.count({ where: { userId: session.userId, usedAt: null } });
    await audit(db, { actorUserId: session.userId, action: "mfa.recovery_code_used", entityType: "User", entityId: session.userId, metadata: { remaining } });
  }
  return { userId: session.userId, usedRecoveryCode };
}

/** Confere um código TOTP da conta já ativa (para ações sensíveis da própria conta). */
async function assertCurrentTotp(db: Db, userId: string, code: string, now: Date) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { totpSecretEncrypted: true, totpEnabledAt: true, totpLastStep: true } });
  if (!user.totpEnabledAt || !user.totpSecretEncrypted) throw invalidState("A verificação em duas etapas não está ativa.");
  const step = verifyTotp(decryptPII(user.totpSecretEncrypted), code, now, user.totpLastStep);
  if (step === null) throw wrongCode();
  const claimed = await db.user.updateMany({ where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step } });
  if (claimed.count !== 1) throw wrongCode();
}

/** Novos códigos de recuperação (os antigos deixam de valer). Exige um código do aplicativo. */
export async function regenerateRecoveryCodes(db: Db, userId: string, code: string, now = new Date()) {
  await assertCurrentTotp(db, userId, code, now);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await db.$transaction(async (tx) => {
    await tx.totpRecoveryCode.deleteMany({ where: { userId } });
    await tx.totpRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: recoveryHash(c) })) });
    await audit(tx, { actorUserId: userId, action: "mfa.recovery_codes_regenerated", entityType: "User", entityId: userId });
  }, TX_OPTIONS);
  return { recoveryCodes: codes };
}

/** Desliga o 2FA. Recusado para contas obrigadas a usá-lo (admin, dono de organização). */
export async function disableTotp(db: Db, userId: string, input: { code: string; password?: string }, now = new Date()) {
  if (mfaEnforced() && (await isMfaRequiredUser(db, userId)))
    throw forbidden("Administradores e donos de organização não podem desativar a verificação em duas etapas.");
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, googleSubject: true } });
  if (!user.googleSubject && !(input.password && (await verifyPassword(input.password, user.passwordHash))))
    throw new AppError("VALIDATION", "Senha atual incorreta.");
  await assertCurrentTotp(db, userId, input.code, now);
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { totpSecretEncrypted: null, totpEnabledAt: null, totpLastStep: null, totpPendingSecretEncrypted: null, totpPendingAt: null },
    });
    await tx.totpRecoveryCode.deleteMany({ where: { userId } });
    await audit(tx, { actorUserId: userId, action: "mfa.disabled", entityType: "User", entityId: userId });
  }, TX_OPTIONS);
}
