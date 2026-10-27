import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { getCurrentUser } from "@/server/auth/current";
import { googleWallet, googleWalletSaveUrl, toWalletTickets } from "@/server/tickets/wallet";
import { loadPdfTickets } from "@/server/services/notifications";

// Leva ao "Salvar no Google Wallet" de um ingresso do próprio comprador.
export async function GET(req: Request, ctx: RouteContext<"/api/tickets/[code]/wallet/google">) {
  const cfg = googleWallet();
  if (!cfg) return new Response("Google Wallet não configurada", { status: 404 });
  const { code } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL(`/entrar?next=${encodeURIComponent(`/ingressos/${code}`)}`, req.url));
  const owner = await db.issuedTicket.findUnique({ where: { code }, select: { userId: true } });
  if (!owner || owner.userId !== user.id) return new Response("Não encontrado", { status: 404 });
  const tickets = await toWalletTickets(db, await loadPdfTickets(db, { code }));
  if (!tickets.length) return new Response("Ingresso indisponível", { status: 410 });
  const res = NextResponse.redirect(googleWalletSaveUrl(tickets, cfg, env().APP_URL));
  res.headers.set("Cache-Control", "no-store");
  return res;
}
