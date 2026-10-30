import "server-only";
import { z } from "zod";
import type { Db, Tx } from "../db";
import type { Actor } from "../auth/permissions";
import { assertActive } from "../auth/permissions";
import { randomToken, hashToken } from "../crypto";
import { env } from "../env";
import { type EmailAdapter } from "../email";
import { AppError } from "../errors";
import { audit } from "../audit";
import { authEmail } from "../email/templates";
import {
  enqueueEmail,
  consumeEmailRateLimit,
  dispatchEmailOutbox,
} from "../email/outbox";

export function internalReturnPath(value?: string | null) {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/.test(value)
  )
    return "/";
  return value;
}
export function authAppUrl() {
  const e = env();
  const url = new URL(e.APP_URL);
  if (e.NODE_ENV === "production" && url.protocol !== "https:")
    throw new AppError(
      "PROVIDER_ERROR",
      "A autenticação exige HTTPS em produção.",
    );
  return url;
}

/** Enqueue proof in the caller's transaction, including initial account creation. */
export async function enqueueVerificationForUserTx(
  tx: Tx,
  user: { id: string; email: string },
  next?: string,
) {
  const rawToken = randomToken();
  const now = new Date();
  const minutes = env().EMAIL_VERIFICATION_EXPIRATION_MINUTES;
  await tx.emailVerificationToken.updateMany({
    where: { userId: user.id, consumedAt: null, expiresAt: { gt: now } },
    data: { expiresAt: now },
  });
  const expiresAt = new Date(now.getTime() + minutes * 60_000);
  const token = await tx.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt,
      createdAt: now,
    },
  });
  await tx.emailOutbox.updateMany({
    where: {
      dedupeKey: { startsWith: "verification:" + user.id + ":" },
      status: "QUEUED",
    },
    data: { status: "CANCELLED", messageEncrypted: null },
  });
  const url = new URL("/confirmar-email", authAppUrl());
  url.searchParams.set("next", internalReturnPath(next));
  url.hash = new URLSearchParams({ token: rawToken }).toString();
  return enqueueEmail(tx, {
    dedupeKey: "verification:" + user.id + ":" + token.id,
    template: "EMAIL_VERIFICATION",
    recipient: user.email,
    expiresAt,
    message: authEmail("verify", url.toString(), minutes),
  });
}
/** Attempts remain counted even on failed delivery; only token hashes enter auth tables. */
export async function requestEmailVerification(
  db: Db,
  actor: Actor,
  next?: string,
  adapter?: EmailAdapter,
  client: { ip?: string } = {},
) {
  assertActive(actor);
  if (client.ip)
    await consumeEmailRateLimit(
      db,
      "verification-ip:" + client.ip,
      20,
      3_600_000,
    );
  const delivery = await db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      'SELECT id FROM "User" WHERE id=$1 FOR UPDATE',
      actor.id,
    );
    const user = await tx.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (user.emailVerifiedAt) return null;
    const now = new Date();
    const [recent, count] = await Promise.all([
      tx.emailVerificationToken.findFirst({
        where: { userId: actor.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      tx.emailVerificationToken.count({
        where: {
          userId: actor.id,
          createdAt: { gte: new Date(now.getTime() - 3_600_000) },
        },
      }),
    ]);
    if (
      count >= 5 ||
      (recent && now.getTime() - recent.createdAt.getTime() < 30_000)
    )
      throw new AppError(
        "RATE_LIMITED",
        "Aguarde antes de solicitar outro e-mail de confirmação.",
      );
    return enqueueVerificationForUserTx(tx, user, next);
  });
  if (delivery && (adapter || env().NODE_ENV !== "test")) {
    const result = await dispatchEmailOutbox(db, {
      ids: [delivery.id],
      adapter,
    });
    if (result.failed)
      throw new AppError(
        "PROVIDER_ERROR",
        "Não foi possível enviar o e-mail. Solicite um novo envio em alguns instantes.",
      );
  }
}

/** Email proof never creates an authenticated session. */
export async function confirmEmailVerification(db: Db, rawToken: string) {
  if (
    !z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .safeParse(rawToken).success
  )
    throw new AppError(
      "VALIDATION",
      "Link de confirmação inválido ou expirado.",
    );
  return db.$transaction(async (tx) => {
    const token = await tx.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (!token)
      throw new AppError(
        "VALIDATION",
        "Link de confirmação inválido ou expirado.",
      );
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${token.userId} FOR UPDATE`;
    const now = new Date();
    const consumed = await tx.emailVerificationToken.updateMany({
      where: { id: token.id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1)
      throw new AppError(
        "VALIDATION",
        "Link de confirmação inválido ou expirado.",
      );
    await tx.user.update({
      where: { id: token.userId },
      data: { emailVerifiedAt: now },
    });
    await tx.emailVerificationToken.updateMany({
      where: { userId: token.userId, consumedAt: null },
      data: { expiresAt: now },
    });
    await audit(tx, {
      actorUserId: token.userId,
      action: "user.email_verified",
      entityType: "User",
      entityId: token.userId,
    });
    return { verified: true as const };
  });
}
