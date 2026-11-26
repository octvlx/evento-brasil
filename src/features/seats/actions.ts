"use server";

import { db } from "@/server/db";
import { toActionResult } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { clientIp } from "@/server/client-ip";
import { publicSeatMap } from "@/server/services/seats";

/** Mapa público de assentos de um tipo de ingresso (livre/ocupado/bloqueado), sem login. */
export async function getSeatMapAction(ticketTypeId: string) {
  return toActionResult(async () => {
    await rateLimit(`seatmap:${(await clientIp()) ?? "local"}`, 120, 60_000);
    return publicSeatMap(db, String(ticketTypeId).slice(0, 64));
  });
}
