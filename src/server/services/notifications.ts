// Notificações pós-confirmação. Executadas fora da transação; falhas de envio
// não afetam o estado do pedido (podem ser reenviadas).
import "server-only";
import type { Db } from "../db";
import { env } from "../env";
import { escapeHtml, getEmailAdapter } from "../email";
import { formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { renderTicketsPdf, type PdfTicket } from "../tickets/pdf";

export async function loadPdfTickets(db: Db, where: { orderId?: string; code?: string }): Promise<PdfTicket[]> {
  const tickets = await db.issuedTicket.findMany({
    where: { ...where, status: { not: "REVOKED" } },
    include: {
      ticketType: { select: { name: true } },
      order: { select: { publicCode: true, isSimulated: true } },
      event: { include: { venue: { include: { city: true } }, city: true, organization: { select: { name: true } } } },
    },
    orderBy: [{ orderItemId: "asc" }, { sequence: "asc" }],
  });
  return tickets.map((t) => {
    const city = t.event.venue?.city ?? t.event.city;
    const place = t.event.locationType === "ONLINE" ? "Online" : [t.event.venue?.name, city && `${city.name} – ${city.state}`].filter(Boolean).join(", ");
    return {
      code: t.code,
      validationToken: t.validationToken,
      holderName: t.holderName,
      ticketTypeName: t.ticketType.name,
      orderCode: t.order.publicCode,
      isSimulated: t.order.isSimulated,
      event: { title: t.event.title, startsAt: t.event.startsAt, endsAt: t.event.endsAt, timezone: t.event.timezone, place, organizer: t.event.organization.name, ageRestriction: t.event.ageRestriction },
    };
  });
}

export async function sendOrderTicketsEmail(db: Db, orderId: string): Promise<void> {
  if (env().NODE_ENV === "test") return;
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { event: true, items: true } });
  const tickets = await loadPdfTickets(db, { orderId });
  if (!tickets.length) return;
  const pdf = await renderTicketsPdf(tickets);
  const url = `${env().APP_URL}/pedido/${order.id}`;
  const when = formatEventDateTime(order.event.startsAt, order.event.timezone);
  const title = escapeHtml(order.event.title);
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#14112b">
<h1 style="color:#312e81">Seus ingressos chegaram!</h1>
${order.isSimulated ? '<p style="color:#be123c"><strong>Ambiente de testes:</strong> pagamento simulado, ingressos sem valor.</p>' : ""}
<p><strong>${title}</strong><br>${escapeHtml(when)}</p>
<p>Pedido ${order.publicCode} · ${tickets.length} ingresso(s) · Total ${formatBRL(order.totalCents)}</p>
<p>Os ingressos estão em anexo (PDF) e também em <a href="${url}">Meus ingressos</a>. Apresente o QR code na entrada; ele vale para uma única leitura.</p>
</body></html>`;
  const text = `Seus ingressos chegaram!\n${order.event.title}\n${when}\nPedido ${order.publicCode}\nAcesse: ${url}`;
  await getEmailAdapter().send({
    to: order.buyerEmail,
    subject: `Ingressos: ${order.event.title}`,
    html,
    text,
    attachments: [{ filename: `ingressos-${order.publicCode}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
}

export function notifyOrderPaid(db: Db, orderId: string) {
  sendOrderTicketsEmail(db, orderId).catch((err) => console.error(`[notificações] falha ao enviar ingressos do pedido ${orderId}:`, err));
}
