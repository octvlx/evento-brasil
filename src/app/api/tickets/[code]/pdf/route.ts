import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { loadPdfTickets } from "@/server/services/notifications";
import { renderTicketsPdf } from "@/server/tickets/pdf";

export async function GET(_req: Request, ctx: RouteContext<"/api/tickets/[code]/pdf">) {
  const { code } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  const owner = await db.issuedTicket.findUnique({ where: { code }, select: { userId: true } });
  if (!owner || owner.userId !== user.id) return new Response("Não encontrado", { status: 404 });
  const tickets = await loadPdfTickets(db, { code });
  if (!tickets.length) return new Response("Ingresso indisponível", { status: 410 });
  const pdf = await renderTicketsPdf(tickets);
  return new Response(Buffer.from(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="ingresso-${code}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
