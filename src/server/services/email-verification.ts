import "server-only";
import { z } from "zod";
import type { Db } from "../db";
import type { Actor } from "../auth/permissions";
import { assertActive } from "../auth/permissions";
import { randomToken, hashToken } from "../crypto";
import { env } from "../env";
import { getEmailAdapter, escapeHtml, type EmailAdapter } from "../email";
import { AppError } from "../errors";
import { audit } from "../audit";

export function internalReturnPath(value?: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return "/";
  return value;
}
export function authAppUrl() {
  const e = env(); const url = new URL(e.APP_URL);
  if (e.NODE_ENV === "production" && url.protocol !== "https:") throw new AppError("PROVIDER_ERROR", "A autenticação exige HTTPS em produção.");
  return url;
}

/** Attempts remain counted even on failed delivery; only token hashes enter the database. */
export async function requestEmailVerification(db: Db, actor: Actor, next?: string, adapter: EmailAdapter = getEmailAdapter()) {
  assertActive(actor);
  const rawToken = randomToken(); const now = new Date();
  const user = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { email: true, emailVerifiedAt: true } });
    if (user.emailVerifiedAt) return null;
    const [recent, count] = await Promise.all([
      tx.emailVerificationToken.findFirst({ where: { userId: actor.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
      tx.emailVerificationToken.count({ where: { userId: actor.id, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } }),
    ]);
    if (count >= 5 || (recent && now.getTime() - recent.createdAt.getTime() < 30_000)) throw new AppError("RATE_LIMITED", "Aguarde antes de solicitar outro e-mail de confirmação.");
    await tx.emailVerificationToken.updateMany({ where: { userId: actor.id, consumedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
    await tx.emailVerificationToken.create({ data: { userId: actor.id, tokenHash: hashToken(rawToken), expiresAt: new Date(now.getTime() + 60 * 60_000) } });
    return user;
  });
  if (!user) return;
  const url = new URL("/confirmar-email", authAppUrl());
  url.searchParams.set("next", internalReturnPath(next));
  url.hash = new URLSearchParams({ token: rawToken }).toString();
  try {
    await adapter.send({ to: user.email, subject: "Confirme seu e-mail — Evento Brasil", text: `Confirme seu e-mail: ${url}\nO link expira em 1 hora. Se você não solicitou, ignore esta mensagem.`, html: `<p>Confirme seu e-mail para concluir suas compras no Evento Brasil.</p><p><a href="${escapeHtml(url.toString())}">Confirmar meu e-mail</a></p><p>O link expira em 1 hora. Se você não solicitou, ignore esta mensagem.</p>` });
  } catch { throw new AppError("PROVIDER_ERROR", "Não foi possível enviar o e-mail. Solicite um novo envio em alguns instantes."); }
}

/** Email proof never creates an authenticated session. */
export async function confirmEmailVerification(db: Db, rawToken: string) {
  if (!z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(rawToken).success) throw new AppError("VALIDATION", "Link de confirmação inválido ou expirado.");
  return db.$transaction(async (tx) => {
    const token = await tx.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
    if (!token) throw new AppError("VALIDATION", "Link de confirmação inválido ou expirado.");
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${token.userId} FOR UPDATE`;
    const now = new Date();
    const consumed = await tx.emailVerificationToken.updateMany({ where: { id: token.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
    if (consumed.count !== 1) throw new AppError("VALIDATION", "Link de confirmação inválido ou expirado.");
    await tx.user.update({ where: { id: token.userId }, data: { emailVerifiedAt: now } });
    await tx.emailVerificationToken.updateMany({ where: { userId: token.userId, consumedAt: null }, data: { expiresAt: now } });
    await audit(tx, { actorUserId: token.userId, action: "user.email_verified", entityType: "User", entityId: token.userId });
    return { verified: true as const };
  });
}
