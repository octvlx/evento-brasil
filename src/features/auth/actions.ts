"use server";

import { dispatchEmailOutbox } from "@/server/email/outbox";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  loginSchema,
  profileSchema,
  type RegisterInput,
} from "@/features/schemas";
import { db } from "@/server/db";
import {
  requestEmailVerification,
  confirmEmailVerification,
  internalReturnPath,
} from "@/server/services/email-verification";
import { registerGoogleUser } from "@/server/services/google-registration";
import { GOOGLE_PENDING_COOKIE } from "@/server/auth/google";
import { env, isProduction } from "@/server/env";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { failureLimiter, rateLimit } from "@/server/rate-limit";
import { createSession, deleteSession } from "@/server/auth/sessions";
import {
  clearSessionCookie,
  getCurrentUser,
  requireUser,
  safeNext,
  SESSION_COOKIE,
  setSessionCookie,
} from "@/server/auth/current";
import {
  authenticate,
  changePassword,
  registerUser,
  updateProfile,
} from "@/server/services/users";
import { deleteOwnAccount } from "@/server/services/account-deletion";

async function clientKey() {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "local"
  );
}

export type LoginState = { error?: string } | undefined;

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Informe e-mail e senha válidos." };
  const key = `login:${await clientKey()}:${parsed.data.email}`;
  const WINDOW = 15 * 60_000;
  try {
    failureLimiter.assert(key, 8, WINDOW);
    const user = await authenticate(
      db,
      parsed.data.email,
      parsed.data.password,
      { production: isProduction() },
    );
    if (!user) {
      failureLimiter.fail(key, WINDOW);
      return { error: "E-mail ou senha incorretos." };
    }
    failureLimiter.reset(key);
    const { token, expiresAt } = await createSession(
      db,
      user.id,
      (await headers()).get("user-agent"),
    );
    await setSessionCookie(token, expiresAt);
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
  redirect(safeNext(formData.get("next")?.toString()));
}

export async function registerAction(
  input: RegisterInput,
  next?: string,
): Promise<ActionResult<{ redirectTo: string }>> {
  return toActionResult(async () => {
    const ip = await clientKey();
    const userAgent = (await headers()).get("user-agent");
    rateLimit(`register:${ip}`, env().SIGNUP_RATE_LIMIT_PER_HOUR, 60 * 60_000);
    const user = await registerUser(
      db,
      input,
      { ip, userAgent },
      safeNext(next),
    );
    const { token, expiresAt } = await createSession(db, user.id, userAgent);
    await setSessionCookie(token, expiresAt);
    // Account creation stays successful even if delivery fails; the confirmation page offers resend.
    try {
      const jobs = await db.emailOutbox.findMany({
        where: {
          dedupeKey: { startsWith: "verification:" + user.id + ":" },
          status: "QUEUED",
        },
        select: { id: true },
      });
      if (process.env.NODE_ENV !== "test")
        await dispatchEmailOutbox(db, {
          ids: jobs.map((job) => job.id),
          limit: 1,
        });
    } catch {
      /* the committed outbox remains available for the worker */
    }
    return {
      redirectTo: "/confirmar-email?next=" + encodeURIComponent(safeNext(next)),
    };
  });
}

export async function logoutAction() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(db, token);
  await clearSessionCookie();
  redirect("/");
}

export type ProfileState = { ok?: boolean; error?: string } | undefined;

export async function updateProfileAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const user = await requireUser("/minha-conta");
  const parsed = profileSchema.safeParse({
    name: formData.get("name"),
    phone: formData.get("phone") || undefined,
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const result = await toActionResult(() =>
    updateProfile(db, user, parsed.data),
  );
  return result.ok ? { ok: true } : { error: result.error };
}

export type DeleteAccountState = { error?: string } | undefined;

/** Exclusão da conta pelo titular (L9b): anonimiza, encerra as sessões e sai. */
export async function deleteAccountAction(
  _prev: DeleteAccountState,
  formData: FormData,
): Promise<DeleteAccountState> {
  const user = await requireUser("/minha-conta");
  const key = `delete-account:${user.id}`;
  const WINDOW = 15 * 60_000;
  try {
    failureLimiter.assert(key, 5, WINDOW);
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
  const result = await toActionResult(() =>
    deleteOwnAccount(db, user, {
      password: String(formData.get("password") ?? ""),
      email: String(formData.get("email") ?? ""),
    }),
  );
  if (!result.ok) {
    if (result.code === "VALIDATION") failureLimiter.fail(key, WINDOW);
    return { error: result.error };
  }
  await clearSessionCookie();
  redirect("/conta-excluida");
}

export type ChangePasswordState = { ok?: boolean; error?: string; field?: "currentPassword" | "newPassword" | "confirmPassword" } | undefined;

/** Troca de senha em Minha conta: identidade pela sessão, senha atual obrigatória, tentativas limitadas. */
export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const user = await requireUser("/minha-conta");
  const key = `change-password:${user.id}`;
  const WINDOW = 15 * 60_000;
  try {
    failureLimiter.assert(key, 5, WINDOW);
  } catch (err) {
    if (err instanceof AppError) return { error: err.message };
    throw err;
  }
  const input = {
    currentPassword: String(formData.get("currentPassword") ?? ""),
    newPassword: String(formData.get("newPassword") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
  };
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const result = await toActionResult(() => changePassword(db, user, input, token));
  if (!result.ok) {
    if (result.error === "A senha atual está incorreta.") {
      failureLimiter.fail(key, WINDOW);
      return { error: result.error, field: "currentPassword" };
    }
    return { error: result.error };
  }
  failureLimiter.reset(key);
  if (process.env.NODE_ENV !== "test") void dispatchEmailOutbox(db, { limit: 5 }).catch(() => {});
  return { ok: true };
}

export async function currentUserSummary() {
  const u = await getCurrentUser();
  return u ? { name: u.name, email: u.email } : null;
}

export async function resendEmailConfirmationAction(next?: string) {
  const user = await requireUser("/confirmar-email");
  const ip = await clientKey();
  return toActionResult(() =>
    requestEmailVerification(db, user, internalReturnPath(next), undefined, {
      ip,
    }),
  );
}

export async function confirmEmailAction(token: string) {
  return toActionResult(() => confirmEmailVerification(db, token));
}

export async function googleSignupAction(
  acceptTerms: boolean,
  acceptPrivacy: boolean,
) {
  return toActionResult(async () => {
    const cookieJar = await cookies();
    const pending = cookieJar.get(GOOGLE_PENDING_COOKIE)?.value;
    const userAgent = (await headers()).get("user-agent");
    const { user, next } = await registerGoogleUser(
      db,
      pending,
      acceptTerms,
      acceptPrivacy,
      { ip: await clientKey(), userAgent },
    );
    cookieJar.delete(GOOGLE_PENDING_COOKIE);
    const session = await createSession(db, user.id, userAgent);
    await setSessionCookie(session.token, session.expiresAt);
    return { redirectTo: safeNext(next) };
  });
}
