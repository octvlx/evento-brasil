"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/server/db";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { clearSessionCookie, requireUser, safeNext, SESSION_COOKIE, setSessionCookie } from "@/server/auth/current";
import { deleteSession, SESSION_TTL_MS } from "@/server/auth/sessions";
import {
  completeMfaLogin,
  confirmTotpEnrollment,
  disableTotp,
  regenerateRecoveryCodes,
  startTotpEnrollment,
} from "@/server/services/two-factor";

async function clientIp() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
}

const sessionToken = async () => (await cookies()).get(SESSION_COOKIE)?.value ?? null;

export type MfaLoginState = { error?: string; expired?: boolean } | undefined;

/** Login, segunda etapa: código do aplicativo ou de recuperação. */
export async function verifyMfaLoginAction(_prev: MfaLoginState, formData: FormData): Promise<MfaLoginState> {
  const token = await sessionToken();
  if (!token) return { error: "A verificação expirou. Entre novamente com e-mail e senha.", expired: true };
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "Digite o código de 6 dígitos do aplicativo." };
  try {
    // Além do limite por sessão (MAX_MFA_ATTEMPTS), um teto por IP contra tentativas em massa.
    await rateLimit(`mfa-login:${await clientIp()}`, 30, 15 * 60_000);
    await completeMfaLogin(db, token, code);
  } catch (err) {
    if (err instanceof AppError) {
      const expired = err.code === "UNAUTHENTICATED" || (err.code === "RATE_LIMITED" && err.message.includes("Entre novamente"));
      if (expired) await clearSessionCookie();
      return { error: err.message, expired };
    }
    throw err;
  }
  // O cookie passa a valer pelo prazo da sessão completa.
  await setSessionCookie(token, new Date(Date.now() + SESSION_TTL_MS));
  redirect(safeNext(formData.get("next")?.toString()));
}

/** Desiste da segunda etapa: apaga a sessão pendente. */
export async function cancelMfaLoginAction() {
  const token = await sessionToken();
  if (token) await deleteSession(db, token);
  await clearSessionCookie();
  redirect("/entrar");
}

export async function startTotpEnrollmentAction(): Promise<ActionResult<{ secret: string; qrDataUrl: string }>> {
  const user = await requireUser("/minha-conta/seguranca");
  return toActionResult(async () => {
    await rateLimit(`mfa-enroll-start:${user.id}`, 10, 15 * 60_000);
    const { secret, qrDataUrl } = await startTotpEnrollment(db, user.id);
    return { secret, qrDataUrl };
  });
}

export async function confirmTotpEnrollmentAction(code: string): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const user = await requireUser("/minha-conta/seguranca");
  return toActionResult(async () => {
    await rateLimit(`mfa-enroll-confirm:${user.id}`, 10, 15 * 60_000);
    return confirmTotpEnrollment(db, user.id, code, await sessionToken());
  });
}

export async function regenerateRecoveryCodesAction(code: string): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const user = await requireUser("/minha-conta/seguranca");
  return toActionResult(async () => {
    await rateLimit(`mfa-recovery-regen:${user.id}`, 10, 15 * 60_000);
    return regenerateRecoveryCodes(db, user.id, code);
  });
}

export async function disableTotpAction(input: { code: string; password?: string }): Promise<ActionResult> {
  const user = await requireUser("/minha-conta/seguranca");
  return toActionResult(async () => {
    await rateLimit(`mfa-disable:${user.id}`, 10, 15 * 60_000);
    await disableTotp(db, user.id, input);
    return undefined;
  });
}
