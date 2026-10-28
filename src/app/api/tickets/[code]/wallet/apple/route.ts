import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { appleWallet, buildApplePass, toWalletTickets } from "@/server/tickets/wallet";
import { loadPdfTickets } from "@/server/services/notifications";

// Passe da Apple Wallet (.pkpass) de um ingresso do próprio comprador.
export async function GET(_req: Request, ctx: RouteContext<"/api/tickets/[code]/wallet/apple">) {
  const cfg = appleWallet();
  if (!cfg) return new Response("Apple Wallet não configurada", { status: 404 });
  const { code } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  const owner = await db.issuedTicket.findUnique({ where: { code }, select: { holderUserId: true } });
  if (!owner || owner.holderUserId !== user.id) return new Response("Não encontrado", { status: 404 });
  const [ticket] = await toWalletTickets(db, await loadPdfTickets(db, { code }));
  if (!ticket) return new Response("Ingresso indisponível", { status: 410 });
  const pass = await buildApplePass(ticket, cfg);
  return new Response(new Uint8Array(pass), {
    headers: {
      "content-type": "application/vnd.apple.pkpass",
      "content-disposition": `attachment; filename="ingresso-${code}.pkpass"`,
      "cache-control": "private, no-store",
    },
  });
}
