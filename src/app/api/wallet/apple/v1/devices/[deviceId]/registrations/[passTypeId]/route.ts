import { db } from "@/server/db";
import { applePassesUpdatedSince } from "@/server/tickets/wallet/passes";

// Web service de passes da Apple: seriais dos passes do aparelho que mudaram desde a
// última consulta (passesUpdatedSince é a marca devolvida em lastUpdated). Nada: 204.
export async function GET(req: Request, ctx: RouteContext<"/api/wallet/apple/v1/devices/[deviceId]/registrations/[passTypeId]">) {
  const { deviceId, passTypeId } = await ctx.params;
  const since = new URL(req.url).searchParams.get("passesUpdatedSince");
  const updated = await applePassesUpdatedSince(db, deviceId, passTypeId, since);
  if (!updated) return new Response(null, { status: 204 });
  return Response.json(updated, { headers: { "cache-control": "no-store" } });
}
