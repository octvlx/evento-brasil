import { db } from "@/server/db";
import { recordExternalView } from "@/server/services/external-events";
import { rateLimit } from "@/server/rate-limit";
import { clientIp } from "@/server/client-ip";

// Visualização da página de um evento externo (contador agregado, sem cookie nem dado
// pessoal). Enviada pelo navegador uma vez por abertura; robôs sem JavaScript não contam.
export async function POST(req: Request, ctx: RouteContext<"/api/externos/[slug]/visualizacao">) {
  const { slug } = await ctx.params;
  const ip = (await clientIp(req.headers)) ?? "local";
  try {
    await rateLimit(`external-view:${ip}:${slug.slice(0, 80)}`, 5, 10 * 60_000);
  } catch {
    return new Response(null, { status: 204 });
  }
  const event = await db.externalEvent.findFirst({ where: { slug: slug.slice(0, 160), review: "PUBLISHED" }, select: { id: true } });
  if (event) await recordExternalView(db, event.id);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
