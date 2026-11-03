"use server";

import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { toActionResult, type ActionResult } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { checkInTicket, type CheckinResponse } from "@/server/services/checkin";

export async function checkInAction(eventId: string, payload: string): Promise<ActionResult<CheckinResponse>> {
  const user = await requireUser(`/check-in/${eventId}`);
  return toActionResult(async () => {
    // Limite generoso por operador (protege contra força bruta de tokens).
    await rateLimit(`checkin:${user.id}`, 120, 60_000);
    return checkInTicket(db, user, eventId, payload.slice(0, 200));
  });
}
