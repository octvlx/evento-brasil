import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { applePassBundleForTickets, applePassForTicket, appleWallet, toWalletTickets } from "@/server/tickets/wallet";
import { loadPdfTickets } from "@/server/services/notifications";

// "Adicionar todos à Apple Wallet": os ingressos válidos do pedido que estão com o
// comprador. Um ingresso: .pkpass; vários: .pkpasses (iOS 15+ adiciona todos juntos).
export async function GET(_req: Request, ctx: RouteContext<"/api/orders/[orderId]/wallet/apple">) {
  const cfg = appleWallet();
  if (!cfg) return new Response("Apple Wallet não configurada", { status: 404 });
  const { orderId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  const order = await db.order.findUnique({ where: { id: orderId }, select: { userId: true, publicCode: true } });
  if (!order || order.userId !== user.id) return new Response("Não encontrado", { status: 404 });
  const tickets = await toWalletTickets(db, await loadPdfTickets(db, { orderId, holderUserId: user.id }));
  if (!tickets.length) return new Response("Nenhum ingresso disponível", { status: 410 });
  const single = tickets.length === 1;
  const body = single ? await applePassForTicket(db, tickets[0], cfg) : await applePassBundleForTickets(db, tickets, cfg);
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": single ? "application/vnd.apple.pkpass" : "application/vnd.apple.pkpasses",
      "content-disposition": `attachment; filename="ingressos-${order.publicCode}.${single ? "pkpass" : "pkpasses"}"`,
      "cache-control": "private, no-store",
    },
  });
}
