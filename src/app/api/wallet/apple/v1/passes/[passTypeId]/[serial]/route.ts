import { db } from "@/server/db";
import { appleWallet } from "@/server/tickets/wallet";
import { authorizedApplePass, currentApplePass } from "@/server/tickets/wallet/passes";

// Web service de passes da Apple: o passe como está agora (anulado e sem QR se o
// ingresso foi reembolsado, cancelado, usado ou transferido). If-Modified-Since → 304.
export async function GET(req: Request, ctx: RouteContext<"/api/wallet/apple/v1/passes/[passTypeId]/[serial]">) {
  const cfg = appleWallet();
  if (!cfg) return new Response(null, { status: 404 });
  const { passTypeId, serial } = await ctx.params;
  const pass = await authorizedApplePass(db, passTypeId, serial, req.headers.get("authorization"));
  if (!pass) return new Response(null, { status: 401 });
  // HTTP-date tem resolução de segundos.
  const lastModified = new Date(Math.floor(pass.changedAt.getTime() / 1000) * 1000);
  const since = Date.parse(req.headers.get("if-modified-since") ?? "");
  if (!Number.isNaN(since) && lastModified.getTime() <= since) return new Response(null, { status: 304 });
  const buf = await currentApplePass(db, pass, cfg);
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "application/vnd.apple.pkpass",
      "last-modified": lastModified.toUTCString(),
      "cache-control": "private, no-store",
    },
  });
}
