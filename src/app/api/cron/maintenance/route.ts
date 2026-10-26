// Job agendado (ex.: a cada minuto): expira reservas vencidas e encerra
// eventos finalizados. Protegido por segredo no header x-cron-secret.
import { db } from "@/server/db";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { completeEndedEvents } from "@/server/services/events";
import { expireStaleOrders } from "@/server/services/orders";

export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(secret, env().CRON_SECRET)) return new Response("forbidden", { status: 403 });
  const [expiredOrders, completedEvents] = [await expireStaleOrders(db), await completeEndedEvents(db)];
  return Response.json({ expiredOrders, completedEvents, at: new Date().toISOString() });
}
