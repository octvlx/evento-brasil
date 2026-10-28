import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { loadPdfTickets } from "@/server/services/notifications";
import { renderTicketsPdf } from "@/server/tickets/pdf";
import { organizerIdentities } from "@/server/tickets/organizer-identity";

export async function GET(_req: Request, ctx: RouteContext<"/api/tickets/[code]/pdf">) {
  const { code } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  const owner = await db.issuedTicket.findUnique({ where: { code }, select: { holderUserId: true } });
  if (!owner || owner.holderUserId !== user.id) return new Response("Não encontrado", { status: 404 });
  const tickets = await loadPdfTickets(db, { code });
  if (!tickets.length) return new Response("Ingresso indisponível", { status: 410 });
  // O tipo do ingresso (meia-entrada exige documento na portaria) e o organizador responsável
  // (razão social/CNPJ, L10b) não vêm de loadPdfTickets.
  const extra = await db.issuedTicket.findMany({ where: { code: { in: tickets.map((t) => t.code) } }, select: { code: true, ticketType: { select: { kind: true } }, event: { select: { organizationId: true } } } });
  const organizers = await organizerIdentities(db, extra.map((k) => k.event.organizationId));
  const pdf = await renderTicketsPdf(
    tickets.map((t) => {
      const k = extra.find((e) => e.code === t.code);
      return { ...t, kind: k?.ticketType.kind, organizerIdentity: k && organizers.get(k.event.organizationId) };
    }),
  );
  return new Response(Buffer.from(pdf), {
    headers: {
      "content-type": "application/pdf",
      // inline: abre no visualizador do navegador, que oferece salvar/compartilhar (download
      // forçado não funciona bem no iPhone, principalmente com o app instalado na tela inicial).
      "content-disposition": `inline; filename="ingresso-${code}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
