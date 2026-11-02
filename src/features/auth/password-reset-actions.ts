"use server";

import { headers } from "next/headers";
import { db } from "@/server/db";
import { AppError, type ActionResult } from "@/server/errors";
import {
  PASSWORD_RESET_MESSAGE,
  requestPasswordReset,
  resetPassword,
} from "@/server/services/password-reset";
import { dispatchEmailOutbox } from "@/server/email/outbox";
import { rateLimit } from "@/server/rate-limit";

async function clientIp() {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "local"
  );
}

export async function requestPasswordResetAction(
  email: string,
): Promise<{ message: string }> {
  try {
    await requestPasswordReset(db, email, { ip: await clientIp() });
    // Delivery is best effort here; the committed outbox is also processed by maintenance.
    if (process.env.NODE_ENV !== "test")
      void dispatchEmailOutbox(db, { limit: 5 }).catch(() => {});
  } catch {
    // Never expose whether an address exists, provider details or request/token data.
  }
  return { message: PASSWORD_RESET_MESSAGE };
}

export async function resetPasswordAction(
  token: string,
  password: string,
  confirmation: string,
): Promise<ActionResult<{ reset: true }>> {
  try {
    rateLimit(`password-reset:consume:${await clientIp()}`, 20, 15 * 60_000);
    const data = await resetPassword(db, { token, password, confirmation });
    // Aviso de segurança: entrega imediata em melhor esforço; o worker cobre falhas.
    if (process.env.NODE_ENV !== "test") void dispatchEmailOutbox(db, { limit: 5 }).catch(() => {});
    return { ok: true, data };
  } catch (error) {
    if (error instanceof AppError)
      return { ok: false, error: error.message, code: error.code };
    return {
      ok: false,
      error:
        "Não foi possível redefinir sua senha. Tente novamente em alguns instantes.",
    };
  }
}
