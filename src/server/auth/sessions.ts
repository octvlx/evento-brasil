import "server-only";
import type { Db } from "../db";
import { hashToken, randomToken } from "../crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Prazo para digitar o código de duas etapas depois da senha. */
export const MFA_PENDING_TTL_MS = 10 * 60_000;

/**
 * Cria a sessão de login. Com a verificação em duas etapas ativa, a sessão nasce
 * pendente (curta e sem autenticar nada) até o código ser conferido em
 * completeMfaLogin. Todo login (senha, Google) passa por aqui.
 */
export async function createSession(db: Db, userId: string, userAgent?: string | null) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
  const mfaPending = Boolean(user?.totpEnabledAt);
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + (mfaPending ? MFA_PENDING_TTL_MS : SESSION_TTL_MS));
  await db.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt, mfaPending, userAgent: userAgent?.slice(0, 300) },
  });
  return { token, expiresAt, mfaPending };
}

export async function resolveSession(db: Db, token: string, opts: { allowMfaPending?: boolean } = {}) {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, name: true, phone: true, emailVerifiedAt: true, platformRole: true, adminRoles: true, status: true, isDemoAccount: true, totpEnabledAt: true } } },
  });
  if (!session) return null;
  // Sessão à espera do código de duas etapas: só a tela de verificação a enxerga.
  if (session.mfaPending && !opts.allowMfaPending) return null;
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
