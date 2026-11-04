import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "../db";
import { adminHas, type AdminPermission } from "./admin-roles";
import { MFA_SETUP_PATH, needsMfaEnrollment } from "./mfa-policy";
import { resolveSession } from "./sessions";

export const SESSION_COOKIE = "eb_session";
export const ACTIVE_ORG_COOKIE = "eb_org";

export const getCurrentUser = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await resolveSession(db, token);
  return session?.user ?? null;
});

export type CurrentUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

export async function requireUser(next?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const query = next ? `?next=${encodeURIComponent(next)}` : "";
    // Senha já conferida, falta o código de duas etapas.
    if (await getPendingMfaSession()) redirect(`/entrar/verificacao${query}`);
    redirect(`/entrar${query}`);
  }
  return user;
}

/** Admin da plataforma; com `perm`, também o sub-papel que a concede (T6). */
export async function requireAdmin(perm?: AdminPermission): Promise<CurrentUser> {
  const user = await requireUser("/admin");
  if (user.platformRole !== "ADMIN") redirect("/");
  if (needsMfaEnrollment(user)) redirect(`${MFA_SETUP_PATH}?exigido=1`);
  if (perm && !adminHas(user.adminRoles, perm)) redirect("/admin?semPermissao=1");
  return user;
}

/** Sessão à espera do código de duas etapas (só para a tela /entrar/verificacao). */
export async function getPendingMfaSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await resolveSession(db, token, { allowMfaPending: true });
  return session?.mfaPending ? { token, session } : null;
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Organização ativa do usuário (cookie validado contra as associações). */
export const getActiveMembership = cache(async (userId: string) => {
  const memberships = await db.organizationMember.findMany({
    where: { userId },
    include: { organization: { select: { id: true, name: true, slug: true, status: true, paymentAccountStatus: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!memberships.length) return { active: null, memberships };
  const wanted = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const active = memberships.find((m) => m.organizationId === wanted) ?? memberships[0];
  return { active, memberships };
});

/** Rota segura para redirect pós-login (somente caminhos internos). */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || /[\\\u0000-\u0020]/.test(next)) return fallback;
  try {
    const target = new URL(next, "https://return.eventobrasil.invalid");
    if (target.origin !== "https://return.eventobrasil.invalid") return fallback;
    return target.pathname + target.search + target.hash;
  } catch { return fallback; }
}
