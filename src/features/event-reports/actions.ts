"use server";

import { getCurrentUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { AppError, toActionResult } from "@/server/errors";
import { reportEvent, type EventReportInput } from "@/server/services/event-reports";

/** Denúncia de evento pela página pública. Sem login, o componente leva para /entrar. */
export async function reportEventAction(eventId: string, raw: EventReportInput) {
  const user = await getCurrentUser();
  return toActionResult(async () => {
    if (!user) throw new AppError("FORBIDDEN", "Entre na sua conta para denunciar.");
    await reportEvent(db, user, String(eventId), raw);
  });
}
