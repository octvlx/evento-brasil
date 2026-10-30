"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { loginSchema, profileSchema, type RegisterInput } from "@/features/schemas";
import { db } from "@/server/db";
import { requestEmailVerification, confirmEmailVerification, internalReturnPath } from "@/server/services/email-verification";
import { registerGoogleUser } from "@/server/services/google-registration";
import { GOOGLE_PENDING_COOKIE } from "@/server/auth/google";
import { isProduction } from "@/server/env";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { failureLimiter, rateLimit } from "@/server/rate-limit";
import { createSession, deleteSession } from "@/server/auth/sessions";
import { clearSessionCookie, getCurrentUser, requireUser, safeNext, SESSION_COOKIE, setSessionCookie } from "@/server/auth/current";
import { authenticate, registerUser, updateProfile } from "@/server/services/users";

async function clientKey() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
}

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "Informe e-mail e senha válidos." };
  const key = `login:${await clientKey()}:${parsed.data.email}`;
  const WINDOW = 15 * 60_000;
  try {
    failureLimiter.assert(key, 8, WINDOW);
    const user = await authenticate(db, parsed.data.email, parsed.data.password, { production: isProduction() });
    if (!user) {
      failureLimiter.fail(key, WINDOW);
      return { error: "E-mail ou senha incorretos." };
    }
    failureLimiter.reset(key);
    const { token, expiresAt } = await createSession(db, user.id, (await headers()).get("user-agent"));
    await setSessionCookie(token, expiresAt);
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
  redirect(safeNext(formData.get("next")?.toString()));
}

export async function registerAction(input: RegisterInput, next?: string): Promise<ActionResult<{ redirectTo: string }>> {
  return toActionResult(async () => {
    const ip = await clientKey();
    const userAgent = (await headers()).get("user-agent");
    rateLimit(`register:${ip}`, 5, 60 * 60_000);
    const user = await registerUser(db, input, { ip, userAgent });
    const { token, expiresAt } = await createSession(db, user.id, userAgent);
    await setSessionCookie(token, expiresAt);
    // Account creation stays successful even if delivery fails; the confirmation page offers resend.
    try { await requestEmailVerification(db, user, next, undefined, { ip }); } catch { /* checkout remains blocked until confirmed */ }
    return { redirectTo: "/confirmar-email?next=" + encodeURIComponent(safeNext(next)) };
  });
}

export async function logoutAction() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(db, token);
  await clearSessionCookie();
  redirect("/");
}

export type ProfileState = { ok?: boolean; error?: string } | undefined;

export async function updateProfileAction(_prev: ProfileState, formData: FormData): Promise<ProfileState> {
  const user = await requireUser("/minha-conta");
  const parsed = profileSchema.safeParse({ name: formData.get("name"), phone: formData.get("phone") || undefined });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const result = await toActionResult(() => updateProfile(db, user, parsed.data));
  return result.ok ? { ok: true } : { error: result.error };
}

export async function currentUserSummary() {
  const u = await getCurrentUser();
  return u ? { name: u.name, email: u.email } : null;
}

export async function resendEmailConfirmationAction(next?: string) {
  const user = await requireUser("/confirmar-email");
  const ip = await clientKey();
  return toActionResult(() => requestEmailVerification(db, user, internalReturnPath(next), undefined, { ip }));
}

export async function confirmEmailAction(token: string) {
  return toActionResult(() => confirmEmailVerification(db, token));
}

export async function googleSignupAction(acceptTerms: boolean, acceptPrivacy: boolean) {
  return toActionResult(async () => {
    const cookieJar = await cookies();
    const pending = cookieJar.get(GOOGLE_PENDING_COOKIE)?.value;
    const userAgent = (await headers()).get("user-agent");
    const { user, next } = await registerGoogleUser(db, pending, acceptTerms, acceptPrivacy, { ip: await clientKey(), userAgent });
    cookieJar.delete(GOOGLE_PENDING_COOKIE);
    const session = await createSession(db, user.id, userAgent);
    await setSessionCookie(session.token, session.expiresAt);
    return { redirectTo: safeNext(next) };
  });
}
