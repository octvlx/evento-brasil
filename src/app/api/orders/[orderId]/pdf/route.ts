import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { loadPdfTickets } from "@/server/services/notifications";
import { renderTicketsPdf } from "@/server/tickets/pdf";
import { organizerIdentities } from "@/server/tickets/organizer-identity";

// Todos os ingressos válidos/utilizados do pedido num PDF (o mesmo anexo do e-mail).
export async function GET(_req: Request, ctx: RouteContext<"/api/orders/[orderId]/pdf">) {
  const { orderId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  const order = await db.order.findUnique({ where: { id: orderId }, select: { userId: true, publicCode: true } });
  if (!order || order.userId !== user.id) return new Response("Não encontrado", { status: 404 });
  const tickets = await loadPdfTickets(db, { orderId, holderUserId: user.id });
  if (!tickets.length) return new Response("Nenhum ingresso disponível", { status: 410 });
  // O tipo do ingresso (meia-entrada exige documento na portaria) e o organizador responsável
  // (razão social/CNPJ, L10b) não vêm de loadPdfTickets.
  const extra = await db.issuedTicket.findMany({ where: { orderId }, select: { code: true, ticketType: { select: { kind: true } }, event: { select: { organizationId: true } } } });
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
      // inline pelo mesmo motivo de /api/tickets/[code]/pdf.
      "content-disposition": `inline; filename="ingressos-${order.publicCode}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
