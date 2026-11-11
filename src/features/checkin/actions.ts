"use server";

import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { toActionResult, type ActionResult } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { checkInTicket, checkinOfflinePackage, syncOfflineCheckins, type CheckinResponse, type OfflineEntry, type OfflinePackage, type OfflineSyncItem } from "@/server/services/checkin";

export async function checkInAction(eventId: string, payload: string): Promise<ActionResult<CheckinResponse>> {
  const user = await requireUser(`/check-in/${eventId}`);
  return toActionResult(async () => {
    // Limite generoso por operador (protege contra força bruta de tokens).
    await rateLimit(`checkin:${user.id}`, 120, 60_000);
    return checkInTicket(db, user, eventId, payload.slice(0, 200));
  });
}

/** Lista para validar sem internet (hashes dos QR do evento). */
export async function offlinePackageAction(eventId: string): Promise<ActionResult<OfflinePackage>> {
  const user = await requireUser(`/check-in/${eventId}`);
  return toActionResult(async () => {
    await rateLimit(`checkin-offline-pkg:${user.id}`, 30, 60 * 60_000);
    return checkinOfflinePackage(db, user, eventId);
  });
}

/** Envia as leituras feitas sem internet; o servidor valida cada uma como no check-in online. */
export async function syncOfflineAction(eventId: string, entries: OfflineEntry[]): Promise<ActionResult<{ items: OfflineSyncItem[]; counters: { admitted: number; total: number } }>> {
  const user = await requireUser(`/check-in/${eventId}`);
  return toActionResult(async () => {
    await rateLimit(`checkin-offline-sync:${user.id}`, 120, 60 * 60_000);
    return syncOfflineCheckins(db, user, eventId, entries);
  });
}
