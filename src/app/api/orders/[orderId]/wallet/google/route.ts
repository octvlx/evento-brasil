import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { getCurrentUser } from "@/server/auth/current";
import { googleWallet, googleWalletSaveUrl, toWalletTickets } from "@/server/tickets/wallet";
import { loadPdfTickets } from "@/server/services/notifications";

// "Salvar todos no Google Wallet": todos os ingressos não cancelados do pedido (link do e-mail).
export async function GET(req: Request, ctx: RouteContext<"/api/orders/[orderId]/wallet/google">) {
  const cfg = googleWallet();
  if (!cfg) return new Response("Google Wallet não configurada", { status: 404 });
  const { orderId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL(`/entrar?next=${encodeURIComponent(`/pedido/${orderId}`)}`, req.url));
  const order = await db.order.findUnique({ where: { id: orderId }, select: { userId: true } });
  if (!order || order.userId !== user.id) return new Response("Não encontrado", { status: 404 });
  const tickets = await toWalletTickets(db, await loadPdfTickets(db, { orderId }));
  if (!tickets.length) return new Response("Nenhum ingresso disponível", { status: 410 });
  const res = NextResponse.redirect(await googleWalletSaveUrl(tickets, cfg, env().APP_URL));
  res.headers.set("Cache-Control", "no-store");
  return res;
}
