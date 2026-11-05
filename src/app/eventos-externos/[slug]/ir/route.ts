import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { recordExternalOutboundClick } from "@/server/services/external-events";

// Saída para o site oficial: conta o clique (agregado, sem dado pessoal) e redireciona
// só para a URL original HTTPS de host autorizado da fonte. Clique de saída não é compra.
export async function GET(req: Request, ctx: RouteContext<"/eventos-externos/[slug]/ir">) {
  const { slug } = await ctx.params;
  const target = await recordExternalOutboundClick(db, slug);
  const res = NextResponse.redirect(target ?? new URL("/eventos", req.url), 303);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "origin");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
