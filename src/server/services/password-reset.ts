import "server-only";
import { z } from "zod";
import type { Db } from "../db";
import { audit } from "../audit";
import { hashPassword } from "../auth/password";
import { hashToken, randomToken } from "../crypto";
import { env } from "../env";
import { AppError } from "../errors";
import { authAppUrl } from "./email-verification";
import { consumeEmailRateLimit, enqueueEmail } from "../email/outbox";
import { authEmail } from "../email/templates";

export const PASSWORD_RESET_MESSAGE =
  "Se este endereço estiver associado a uma conta com senha, enviaremos um link de recuperação. Confira também a caixa de spam.";
const emailSchema = z.string().trim().toLowerCase().email().max(200);
const resetSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z
    .string()
    .min(8, "A senha deve ter ao menos 8 caracteres.")
    .max(200, "A senha deve ter no máximo 200 caracteres."),
});
const invalidLink = () =>
  new AppError(
    "VALIDATION",
    "O link de recuperação é inválido, já foi utilizado ou expirou. Solicite um novo link.",
  );

/** Identical public response for absent, suspended, Google-only and throttled accounts. */
export async function requestPasswordReset(
  db: Db,
  rawEmail: unknown,
  client: { ip?: string | null } = {},
) {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) return { message: PASSWORD_RESET_MESSAGE };
  const email = parsed.data;
  try {
    await consumeEmailRateLimit(
      db,
      hashToken(`reset-ip:${client.ip || "unknown"}`),
      20,
      3_600_000,
    );
    await consumeEmailRateLimit(
      db,
      hashToken(`reset-email-hour:${email}`),
      5,
      3_600_000,
    );
    await consumeEmailRateLimit(
      db,
      hashToken(`reset-email-cooldown:${email}`),
      1,
      30_000,
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED")
      return { message: PASSWORD_RESET_MESSAGE };
    throw error;
  }
  const account = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!account) return { message: PASSWORD_RESET_MESSAGE };
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${account.id} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({
      where: { id: account.id },
      select: { email: true, status: true, googleSubject: true },
    });
    // A password-reset link must not turn Google-only login into a password account.
    if (user.status !== "ACTIVE" || user.googleSubject) return;
    const now = new Date();
    const minutes = env().PASSWORD_RESET_EXPIRATION_MINUTES;
    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    const rawToken = randomToken(32);
    await tx.passwordResetToken.updateMany({
      where: { userId: account.id, consumedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    await tx.emailOutbox.updateMany({
      where: {
        template: "PASSWORD_RESET",
        recipient: user.email.toLowerCase(),
        status: "QUEUED",
      },
      data: {
        status: "CANCELLED",
        messageEncrypted: null,
        payloadEncrypted: null,
      },
    });
    const token = await tx.passwordResetToken.create({
      data: {
        userId: account.id,
        tokenHash: hashToken(rawToken),
        expiresAt,
        createdAt: now,
      },
    });
    const url = new URL("/redefinir-senha", authAppUrl());
    url.hash = new URLSearchParams({ token: rawToken }).toString();
    await enqueueEmail(tx, {
      dedupeKey: `password-reset:${token.id}`,
      template: "PASSWORD_RESET",
      recipient: user.email,
      message: authEmail("reset", url.toString(), minutes),
      expiresAt,
    });
  });
  return { message: PASSWORD_RESET_MESSAGE };
}

/** Consumes one proof and changes the password/revokes sessions in the same transaction. */
export async function resetPassword(db: Db, raw: unknown) {
  const parsed = resetSchema.safeParse(raw);
  if (!parsed.success) {
    const passwordIssue = parsed.error.issues.find(
      (issue) => issue.path[0] === "password",
    );
    if (passwordIssue) throw new AppError("VALIDATION", passwordIssue.message);
    throw invalidLink();
  }
  const token = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(parsed.data.token) },
    select: { id: true, userId: true },
  });
  if (!token) throw invalidLink();
  const passwordHash = await hashPassword(parsed.data.password);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${token.userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({
      where: { id: token.userId },
      select: { email: true, status: true, googleSubject: true },
    });
    if (user.status !== "ACTIVE" || user.googleSubject) throw invalidLink();
    const now = new Date();
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: token.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) throw invalidLink();
    await tx.user.update({
      where: { id: token.userId },
      data: { passwordHash },
    });
    await tx.passwordResetToken.updateMany({
      where: { userId: token.userId, consumedAt: null },
      data: { expiresAt: now },
    });
    await tx.session.deleteMany({ where: { userId: token.userId } });
    await tx.emailOutbox.updateMany({
      where: {
        template: "PASSWORD_RESET",
        recipient: user.email.toLowerCase(),
        status: "QUEUED",
      },
      data: {
        status: "CANCELLED",
        messageEncrypted: null,
        payloadEncrypted: null,
      },
    });
    await audit(tx, {
      actorUserId: token.userId,
      action: "user.password_reset",
      entityType: "User",
      entityId: token.userId,
    });
    return { reset: true as const };
  });
}
