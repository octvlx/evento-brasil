import "server-only";
import type { Db } from "../db";
import { hashToken, randomToken } from "../crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(db: Db, userId: string, userAgent?: string | null) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt, userAgent: userAgent?.slice(0, 300) },
  });
  return { token, expiresAt };
}

export async function resolveSession(db: Db, token: string) {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, name: true, phone: true, platformRole: true, status: true, isDemoAccount: true } } },
  });
  if (!session) return null;
  if (session.expiresAt < new Date() || session.user.status !== "ACTIVE") {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  // Atualiza "visto por último" no máximo a cada hora.
  if (Date.now() - session.lastSeenAt.getTime() > 3_600_000) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return session;
}

export async function deleteSession(db: Db, token: string) {
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function revokeAllSessions(db: Db, userId: string) {
  await db.session.deleteMany({ where: { userId } });
}
