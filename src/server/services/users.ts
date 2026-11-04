import "server-only";
import type { z } from "zod";
import { enqueueVerificationForUserTx } from "./email-verification";
import {
  changePasswordSchema,
  profileSchema,
  registerSchema,
  type RegisterInput,
} from "@/features/schemas";
import { PASSWORD_MESSAGES } from "@/lib/password-policy";
import { enqueueEmail } from "../email/outbox";
import { passwordChangedEmail } from "../email/templates";
import { hashToken } from "../crypto";
import { authAppUrl } from "./email-verification";
import { onlyDigits } from "@/lib/br";
import type { Db } from "../db";
import { audit } from "../audit";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/password";
import { assertAcceptableNewPassword } from "../auth/breached-password";
import { assertActive, type Actor, assertAdminPermission } from "../auth/permissions";
import { revokeAllSessions } from "../auth/sessions";
import { ADMIN_ROLES } from "../auth/admin-roles";
import { AppError } from "../errors";
import { BUYER_KINDS, recordAcceptanceTx } from "./terms";

/** Erro de validação com a primeira mensagem do schema (pt-BR), em vez de ZodError. */
function parseOrThrow<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Dados inválidos.");
  return parsed.data;
}

/** O schema exige os dois aceites; o aceite das versões vigentes é gravado junto com a conta (R10). */
export async function registerUser(
  db: Db,
  raw: RegisterInput,
  client: { ip?: string | null; userAgent?: string | null } = {},
  verificationNext?: string,
) {
  const input = parseOrThrow(registerSchema, raw);
  await assertAcceptableNewPassword(input.password);
  const exists = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (exists)
    throw new AppError("CONFLICT", "Já existe uma conta com este e-mail.");
  const passwordHash = await hashPassword(input.password);
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
        phone: input.phone ? onlyDigits(input.phone) : null,
        passwordHash,
      },
    });
    const accepted = await recordAcceptanceTx(tx, user.id, BUYER_KINDS, {
      context: "SIGNUP",
      ...client,
    });
    await audit(tx, {
      actorUserId: user.id,
      action: "user.registered",
      entityType: "User",
      entityId: user.id,
      metadata: {
        termsAccepted: accepted.map((v) => `${v.kind}:${v.version}`),
      },
    });
    await enqueueVerificationForUserTx(tx, user, verificationNext);
    return user;
  });
}

/** Retorna o usuário autenticado ou null. Contas demo são recusadas em produção. */
export async function authenticate(
  db: Db,
  email: string,
  password: string,
  opts: { production: boolean },
) {
  const user = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) return null;
  if (user.status !== "ACTIVE")
    throw new AppError(
      "FORBIDDEN",
      "Sua conta está suspensa. Fale com o suporte.",
    );
  if (opts.production && user.isDemoAccount)
    throw new AppError(
      "FORBIDDEN",
      "Contas de demonstração não podem ser usadas em produção.",
    );
  return user;
}

export async function updateProfile(db: Db, actor: Actor, raw: unknown) {
  assertActive(actor);
  const input = profileSchema.parse(raw);
  return db.user.update({
    where: { id: actor.id },
    data: {
      name: input.name,
      phone: input.phone ? onlyDigits(input.phone) : null,
    },
  });
}

export async function setUserSuspended(
  db: Db,
  admin: Actor,
  userId: string,
  suspended: boolean,
  reason?: string,
) {
  assertAdminPermission(admin, "users:manage");
  if (userId === admin.id)
    throw new AppError(
      "VALIDATION",
      "Você não pode suspender a própria conta.",
    );
  const target = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { anonymizedAt: true } });
  // Conta excluída pelo titular: fica suspensa e anonimizada para sempre.
  if (target.anonymizedAt)
    throw new AppError("INVALID_STATE", "Esta conta foi excluída pelo titular e não pode ser reativada.");
  const user = await db.user.update({
    where: { id: userId },
    data: {
      status: suspended ? "SUSPENDED" : "ACTIVE",
      suspendedReason: suspended ? (reason ?? null) : null,
    },
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

/**
 * Troca de senha em Minha conta. A identidade vem da sessão (actor), nunca do cliente;
 * a senha atual é obrigatória. Erros de digitação não mexem em nada. Sucesso: grava o
 * novo hash, encerra as OUTRAS sessões (a atual continua), invalida links de
 * redefinição pendentes e envia o aviso por e-mail. O limite de tentativas fica na ação.
 */
export async function changePassword(db: Db, actor: Actor, raw: unknown, currentSessionToken: string | null) {
  assertActive(actor);
  const input = parseOrThrow(changePasswordSchema, raw);
  const account = await db.user.findUniqueOrThrow({ where: { id: actor.id }, select: { passwordHash: true, googleSubject: true } });
  if (account.googleSubject) throw new AppError("INVALID_STATE", "Você utiliza o Google para acessar sua conta.");
  if (!(await verifyPassword(input.currentPassword, account.passwordHash))) {
    throw new AppError("VALIDATION", "A senha atual está incorreta.");
  }
  if (input.newPassword === input.currentPassword || (await verifyPassword(input.newPassword, account.passwordHash))) {
    throw new AppError("VALIDATION", PASSWORD_MESSAGES.sameAsCurrent);
  }
  await assertAcceptableNewPassword(input.newPassword);
  const passwordHash = await hashPassword(input.newPassword);
  const keepTokenHash = currentSessionToken ? hashToken(currentSessionToken) : null;

  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id} FOR UPDATE`;
    // Sob a trava: se outra troca terminou antes, a "senha atual" informada já não vale.
    const locked = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { email: true, passwordHash: true } });
    if (locked.passwordHash !== account.passwordHash) throw new AppError("VALIDATION", "A senha atual está incorreta.");
    await tx.user.update({ where: { id: actor.id }, data: { passwordHash } });
    const sessions = await tx.session.deleteMany({
      where: { userId: actor.id, ...(keepTokenHash ? { NOT: { tokenHash: keepTokenHash } } : {}) },
    });
    const now = new Date();
    await tx.passwordResetToken.updateMany({ where: { userId: actor.id, consumedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
    await enqueueEmail(tx, {
      dedupeKey: `password-changed:account:${actor.id}:${now.getTime()}`,
      template: "PASSWORD_CHANGED",
      recipient: locked.email,
      message: passwordChangedEmail("changed", new URL("/esqueci-minha-senha", authAppUrl()).toString()),
    });
    await audit(tx, {
      actorUserId: actor.id,
      action: "user.password_changed",
      entityType: "User",
      entityId: actor.id,
      metadata: { otherSessionsRevoked: sessions.count },
    });
    return { otherSessionsRevoked: sessions.count };
  });
}

/**
 * Papéis de um admin da plataforma (T6). Só SUPER_ADMIN altera; ninguém altera os
 * próprios papéis (o que também garante que sempre sobra um super admin: quem
 * altera). Vale na próxima requisição da pessoa (a sessão lê os papéis a cada vez).
 */
export async function setAdminRoles(db: Db, admin: Actor, userId: string, roles: readonly string[]) {
  assertAdminPermission(admin, "admins:manage");
  if (userId === admin.id) throw new AppError("VALIDATION", "Você não pode alterar os próprios papéis.");
  const next = ADMIN_ROLES.filter((r) => roles.includes(r));
  if (next.length !== new Set(roles).size) throw new AppError("VALIDATION", "Papel de administrador inválido.");
  if (!next.length) throw new AppError("VALIDATION", "Escolha ao menos um papel.");
  return db.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId }, select: { platformRole: true, adminRoles: true, anonymizedAt: true } });
    if (!target) throw new AppError("NOT_FOUND", "Usuário não encontrado.");
    if (target.platformRole !== "ADMIN" || target.anonymizedAt) throw new AppError("INVALID_STATE", "Esta conta não é de administrador.");
    await tx.user.update({ where: { id: userId }, data: { adminRoles: next } });
    await audit(tx, {
      actorUserId: admin.id,
      action: "admin.roles_changed",
      entityType: "User",
      entityId: userId,
      metadata: { before: target.adminRoles, after: next },
    });
    return next;
  });
}
