import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { recordTrackingClick } from "@/server/services/catalog";
import { ATTR_COOKIE, attributionCookieOptions, encodeAttribution } from "@/features/orders/attribution";

// Link rastreado (ADR 0002, D5): conta o clique, grava o cookie de atribuição
// (último clique vence) e leva ao evento. Código desconhecido ou arquivado vai
// para a lista de eventos, sem cookie.
export async function GET(req: Request, ctx: RouteContext<"/r/[code]">) {
  const { code } = await ctx.params;
  const link = await recordTrackingClick(db, code);
  if (!link) return noStore(NextResponse.redirect(new URL("/eventos", req.url)));
  const res = NextResponse.redirect(new URL(`/eventos/${link.event.slug}`, req.url));
  res.cookies.set(
    ATTR_COOKIE,
    encodeAttribution({
      trackingLinkId: link.id,
      utmSource: link.utmSource ?? undefined,
      utmMedium: link.utmMedium ?? undefined,
      utmCampaign: link.utmCampaign ?? undefined,
      utmContent: link.utmContent ?? undefined,
      utmTerm: link.utmTerm ?? undefined,
    }),
    attributionCookieOptions(),
  );
  return noStore(res);
}

// Cada acesso conta um clique: o redirecionamento não pode ficar em cache.
function noStore(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store");
  return res;
}
