import { connection } from "next/server";
import { db } from "@/server/db";
import { getPublicEvent } from "@/server/services/catalog";
import { buildIcs, eventAddress } from "@/lib/event-links";

// "Adicionar à agenda" (.ics) de um evento público. Mesma regra de visibilidade da página.
export async function GET(_req: Request, ctx: RouteContext<"/eventos/[slug]/agenda">) {
  await connection();
  const { slug } = await ctx.params;
  const data = await getPublicEvent(db, slug);
  if (!data) return new Response("Evento não encontrado", { status: 404 });
  const { event } = data;
  const base = new URL(process.env.APP_URL ?? "http://localhost:3000");
  const url = `${base.origin}/eventos/${event.slug}`;
  const ics = buildIcs(
    {
      id: event.id,
      title: event.title,
      description: event.summary,
      location: event.locationType === "ONLINE" ? "Evento online" : (eventAddress(event)?.full ?? null),
      url,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
    },
    base.hostname,
  );
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${event.slug}.ics"`,
      "cache-control": "public, max-age=300",
    },
  });
}
