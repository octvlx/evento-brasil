import "server-only";
import { profileSchema, registerSchema, type RegisterInput } from "@/features/schemas";
import { onlyDigits } from "@/lib/br";
import { consumeSignupPhoneVerification } from "./phone-verification";
import type { Db } from "../db";
import { audit } from "../audit";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/password";
import { assertActive, assertPlatformAdmin, type Actor } from "../auth/permissions";
import { revokeAllSessions } from "../auth/sessions";
import { AppError } from "../errors";
import { BUYER_KINDS, recordAcceptanceTx } from "./terms";

/** O schema exige os dois aceites; o aceite das versões vigentes é gravado junto com a conta (R10). */
export async function registerUser(db: Db, raw: RegisterInput, client: { ip?: string | null; userAgent?: string | null } = {}) {
  const input = registerSchema.parse(raw);
  const exists = await db.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (exists) throw new AppError("CONFLICT", "Já existe uma conta com este e-mail.");
  const passwordHash = await hashPassword(input.password);
  return db.$transaction(async (tx) => {
    const { smsConsentAt, ...verifiedPhone } = await consumeSignupPhoneVerification(tx, input);
    const user = await tx.user.create({
      data: { name: input.name, email: input.email, ...verifiedPhone, passwordHash },
    });
    const accepted = await recordAcceptanceTx(tx, user.id, BUYER_KINDS, { context: "SIGNUP", ...client });
    await audit(tx, {
      actorUserId: user.id,
      action: "user.registered",
      entityType: "User",
      entityId: user.id,
      metadata: { termsAccepted: accepted.map((v) => `${v.kind}:${v.version}`), smsConsentAt: smsConsentAt.toISOString(), smsConsentPurpose: "signup-security-sms@1" },
    });
    return user;
  });
}

/** Retorna o usuário autenticado ou null. Contas demo são recusadas em produção. */
export async function authenticate(db: Db, email: string, password: string, opts: { production: boolean }) {
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) return null;
  if (user.status !== "ACTIVE") throw new AppError("FORBIDDEN", "Sua conta está suspensa. Fale com o suporte.");
  if (opts.production && user.isDemoAccount) throw new AppError("FORBIDDEN", "Contas de demonstração não podem ser usadas em produção.");
  return user;
}

export async function updateProfile(db: Db, actor: Actor, raw: unknown) {
  assertActive(actor);
  const input = profileSchema.parse(raw);
  return db.$transaction(async (tx) => {
    // Serialize profile edits so changing a phone cannot retain a stale verification flag.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id} FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { phone: true } });
    const phone = input.phone ? onlyDigits(input.phone) : null;
    const canonical = (value: string | null) => { const d = onlyDigits(value ?? ""); return d.length === 11 ? `55${d}` : d; };
    return tx.user.update({ where: { id: actor.id }, data: { name: input.name, phone, ...(canonical(phone) !== canonical(current.phone) ? { phoneVerifiedAt: null } : {}) } });
  });
}

export async function setUserSuspended(db: Db, admin: Actor, userId: string, suspended: boolean, reason?: string) {
  assertPlatformAdmin(admin);
  if (userId === admin.id) throw new AppError("VALIDATION", "Você não pode suspender a própria conta.");
  const user = await db.user.update({
    where: { id: userId },
    data: { status: suspended ? "SUSPENDED" : "ACTIVE", suspendedReason: suspended ? (reason ?? null) : null },
  });
  if (suspended) await revokeAllSessions(db, userId);
  await audit(db, {
    actorUserId: admin.id,
    action: suspended ? "user.suspended" : "user.reinstated",
    entityType: "User",
    entityId: userId,
    metadata: { reason: reason ?? null },
  });
  return user;
}
