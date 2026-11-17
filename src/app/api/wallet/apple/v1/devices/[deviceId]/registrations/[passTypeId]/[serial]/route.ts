import { db } from "@/server/db";
import { authorizedApplePass, registerAppleDevice, unregisterAppleDevice } from "@/server/tickets/wallet/passes";

// Web service de passes da Apple: o aparelho se registra para receber avisos de um
// passe (POST) e cancela o registro (DELETE). Autenticação: "ApplePass <token>".
type Ctx = RouteContext<"/api/wallet/apple/v1/devices/[deviceId]/registrations/[passTypeId]/[serial]">;

export async function POST(req: Request, ctx: Ctx) {
  const { deviceId, passTypeId, serial } = await ctx.params;
  const pass = await authorizedApplePass(db, passTypeId, serial, req.headers.get("authorization"));
  if (!pass) return new Response(null, { status: 401 });
  const body = (await req.json().catch(() => null)) as { pushToken?: unknown } | null;
  const result = await registerAppleDevice(db, pass, deviceId, body?.pushToken);
  if (result === "invalid") return new Response(null, { status: 400 });
  return new Response(null, { status: result === "created" ? 201 : 200 });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { deviceId, passTypeId, serial } = await ctx.params;
  const pass = await authorizedApplePass(db, passTypeId, serial, req.headers.get("authorization"));
  if (!pass) return new Response(null, { status: 401 });
  await unregisterAppleDevice(db, pass, deviceId);
  return new Response(null, { status: 200 });
}
