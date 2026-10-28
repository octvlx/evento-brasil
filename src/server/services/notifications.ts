// Notificações pós-confirmação. Executadas fora da transação; falhas de envio
// não afetam o estado do pedido (podem ser reenviadas).
import "server-only";
import type { Db } from "../db";
import { env } from "../env";
import { escapeHtml, getEmailAdapter, type EmailAdapter } from "../email";
import { audit } from "../audit";
import { describeChangeValue, isRelevantField, RELEVANT_FIELD_LABELS, type ChangeSnapshotJson } from "@/features/organizer/event-change-rules";
import { formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { renderTicketsPdf, type PdfTicket } from "../tickets/pdf";
import { appleWallet, buildApplePass, googleWallet, toWalletTickets } from "../tickets/wallet";

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

// Os .pkpass são um extra: certificado vencido ou mal configurado não pode impedir
// o envio dos ingressos (PDF), então a falha só é registrada e o e-mail segue sem eles.
async function applePassesForEmail(db: Db, tickets: PdfTicket[], orderId: string): Promise<{ code: string; pass: Buffer }[]> {
  const apple = appleWallet();
  if (!apple) return [];
  try {
    return await Promise.all((await toWalletTickets(db, tickets)).map(async (t) => ({ code: t.code, pass: await buildApplePass(t, apple) })));
  } catch (err) {
    console.error(`[notificações] falha ao gerar .pkpass do pedido ${orderId}; e-mail segue sem Apple Wallet:`, err);
    return [];
  }
}

export async function sendOrderTicketsEmail(db: Db, orderId: string): Promise<void> {
  if (env().NODE_ENV === "test") return;
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { event: true, items: true } });
  const tickets = await loadPdfTickets(db, { orderId });
  if (!tickets.length) return;
  const pdf = await renderTicketsPdf(tickets);
  const url = `${env().APP_URL}/pedido/${order.id}`;
  // Carteiras: só quando configuradas (docs/wallet.md). Um .pkpass por ingresso;
  // o Google Wallet salva todos de uma vez por um link (exige login, sem segredo no e-mail).
  const passes = await applePassesForEmail(db, tickets, orderId);
  const googleUrl = googleWallet() ? `${env().APP_URL}/api/orders/${order.id}/wallet/google` : null;
  const walletHtml = [
    passes.length ? "<p>Para a <strong>Apple Wallet</strong>, abra no iPhone os arquivos <em>.pkpass</em> em anexo.</p>" : "",
    googleUrl ? `<p><a href="${googleUrl}">Salvar os ingressos no Google Wallet</a></p>` : "",
  ].join("");
  const when = formatEventDateTime(order.event.startsAt, order.event.timezone);
  const title = escapeHtml(order.event.title);
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#14112b">
<h1 style="color:#312e81">Seus ingressos chegaram!</h1>
${order.isSimulated ? '<p style="color:#be123c"><strong>Ambiente de testes:</strong> pagamento simulado, ingressos sem valor.</p>' : ""}
<p><strong>${title}</strong><br>${escapeHtml(when)}</p>
<p>Pedido ${order.publicCode} · ${tickets.length} ingresso(s) · Total ${formatBRL(order.totalCents)}</p>
<p>Os ingressos estão em anexo (PDF) e também em <a href="${url}">Meus ingressos</a>. Apresente o QR code na entrada; ele vale para uma única leitura.</p>
${walletHtml}
</body></html>`;
  const text = `Seus ingressos chegaram!\n${order.event.title}\n${when}\nPedido ${order.publicCode}\nAcesse: ${url}${googleUrl ? `\nGoogle Wallet: ${googleUrl}` : ""}`;
  await getEmailAdapter().send({
    to: order.buyerEmail,
    subject: `Ingressos: ${order.event.title}`,
    html,
    text,
    attachments: [
      { filename: `ingressos-${order.publicCode}.pdf`, content: pdf, contentType: "application/pdf" },
      ...passes.map((p) => ({ filename: `ingresso-${p.code}.pkpass`, content: new Uint8Array(p.pass), contentType: "application/vnd.apple.pkpass" })),
    ],
  });
}

export function notifyOrderPaid(db: Db, orderId: string) {
  sendOrderTicketsEmail(db, orderId).catch((err) => console.error(`[notificações] falha ao enviar ingressos do pedido ${orderId}:`, err));
}

/**
 * Avisa compradores (pedido pago antes da alteração) e titulares atuais dos ingressos
 * sobre uma alteração relevante ou a prorrogação da janela de reembolso (R8).
 * Um e-mail por endereço. Registra `event.change_notified` com a quantidade enviada.
 */
export async function notifyEventChange(db: Db, changeId: string, adapter: EmailAdapter = getEmailAdapter()): Promise<{ sent: number; failed: number }> {
  const change = await db.eventChange.findUniqueOrThrow({ where: { id: changeId }, include: { event: true, extends: true } });
  const root = change.extends ?? change;
  const orders = await db.order.findMany({
    where: { eventId: change.eventId, status: "PAID", paidAt: { lt: root.createdAt } },
    select: { buyerEmail: true, tickets: { where: { status: { not: "REVOKED" } }, select: { holder: { select: { email: true } } } } },
  });
  const recipients = [...new Set(orders.flatMap((o) => [o.buyerEmail, ...o.tickets.map((t) => t.holder.email)]).map((e) => e.trim().toLowerCase()))];
  const ev = change.event;
  const tz = ev.timezone;
  const title = escapeHtml(ev.title);
  const until = change.refundUntil ? formatDateTimeShort(change.refundUntil, tz) : null;
  const ordersUrl = `${env().APP_URL}/meus-pedidos`;
  const before = change.before as ChangeSnapshotJson;
  const after = change.after as ChangeSnapshotJson;
  const lines = change.changedFields.filter(isRelevantField).map((f) => ({
    label: RELEVANT_FIELD_LABELS[f],
    from: describeChangeValue(f, before, tz),
    to: describeChangeValue(f, after, tz),
  }));
  const isExtension = !!change.extendsChangeId;
  const subject = isExtension ? `Prazo de reembolso prorrogado: ${ev.title}` : `Alteração no evento: ${ev.title}`;
  const intro = isExtension
    ? `<p>O organizador prorrogou o prazo para pedir reembolso integral por causa da alteração de <strong>${title}</strong>.</p>`
    : `<p>O organizador alterou <strong>${title}</strong>, evento para o qual você tem ingresso.</p>`;
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#14112b">
<h1 style="color:#312e81">${isExtension ? "Prazo de reembolso prorrogado" : "O evento mudou"}</h1>
${intro}
${lines.length ? `<ul>${lines.map((l) => `<li><strong>${escapeHtml(l.label)}:</strong> ${escapeHtml(l.from)} → <strong>${escapeHtml(l.to)}</strong></li>`).join("")}</ul>` : ""}
<p><strong>Motivo informado pelo organizador:</strong> ${escapeHtml(change.reason)}</p>
${until ? `<p>Se não puder ou não quiser ir, você pode pedir o <strong>reembolso integral</strong> até <strong>${escapeHtml(until)}</strong> (horário do evento) em <a href="${ordersUrl}">Meus pedidos</a>.</p>` : ""}
<p>Se continuar com o ingresso, não precisa fazer nada: ele segue válido.</p>
</body></html>`;
  const text = [
    isExtension ? "Prazo de reembolso prorrogado" : "O evento mudou",
    ev.title,
    ...lines.map((l) => `${l.label}: ${l.from} -> ${l.to}`),
    `Motivo: ${change.reason}`,
    until ? `Reembolso integral até ${until} (horário do evento): ${ordersUrl}` : "",
    "Se continuar com o ingresso, não precisa fazer nada.",
  ]
    .filter(Boolean)
    .join("\n");
  let sent = 0;
  let failed = 0;
  for (const to of recipients) {
    try {
      await adapter.send({ to, subject, html, text });
      sent++;
    } catch (err) {
      failed++;
      console.error(`[notificações] falha ao avisar ${to} da alteração ${changeId}:`, err);
    }
  }
  await audit(db, {
    organizationId: change.organizationId,
    action: "event.change_notified",
    entityType: "EventChange",
    entityId: change.id,
    metadata: { recipients: recipients.length, sent, failed },
  });
  return { sent, failed };
}

export function notifyEventChangeInBackground(db: Db, changeId: string) {
  if (env().NODE_ENV === "test") return;
  notifyEventChange(db, changeId).catch((err) => console.error(`[notificações] falha ao avisar a alteração ${changeId}:`, err));
}
