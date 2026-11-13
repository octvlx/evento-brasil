import "server-only";
import type { Db, Tx } from "../db";
import { env } from "../env";
import { enqueueEmail } from "./outbox";
import { transactionalEmail } from "./templates";
import { formatBRL } from "@/lib/money";
import { formatDateTimeShort } from "@/lib/datetime";
import type { CancellationOutcome } from "../services/cancellation-requests";
export async function enqueueOrderEmailsTx(tx: Db | Tx, orderId: string) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true, buyerEmail: true },
  });
  if (!order || order.status !== "PAID") return;
  for (const template of ["PURCHASE_CONFIRMATION", "TICKET_DELIVERY"])
    await enqueueEmail(tx, {
      dedupeKey: template + ":" + orderId,
      template,
      recipient: order.buyerEmail,
      payload: { orderId },
    });
}
export async function enqueueRefundEmailTx(tx: Tx, refundId: string) {
  const refund = await tx.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { order: { include: { event: true } } },
  });
  if (refund.status !== "SUCCEEDED") return;
  const o = refund.order;
  await enqueueEmail(tx, {
    dedupeKey: "refund:" + refund.id,
    template: "REFUND_CONFIRMATION",
    recipient: o.buyerEmail,
    message: transactionalEmail(
      "refund",
      o.event.title,
      [
        "Status do reembolso: confirmado pelo sistema financeiro.",
        "Pedido " + o.publicCode,
        "Valor: " + formatBRL(refund.amountCents),
        "O prazo para aparecer na sua conta depende do meio de pagamento e da instituição.",
      ],
      env().APP_URL + "/pedido/" + o.id,
    ),
  });
}
export async function enqueueCancelledEventEmailsTx(tx: Tx, eventId: string) {
  const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
  const orders = await tx.order.findMany({
    where: { eventId, status: "PAID" },
    select: {
      buyerEmail: true,
      tickets: { select: { holder: { select: { email: true } } } },
    },
  });
  const recipients = [
    ...new Set(
      orders.flatMap((o) => [
        o.buyerEmail,
        ...o.tickets.map((t) => t.holder.email),
      ]),
    ),
  ];
  for (const recipient of recipients)
    await enqueueEmail(tx, {
      dedupeKey: "cancel:" + eventId + ":" + recipient.toLowerCase(),
      template: "EVENT_CANCELLED",
      recipient,
      message: transactionalEmail(
        "cancelled",
        event.title,
        [
          "O evento foi cancelado.",
          "Motivo: " +
            (event.cancellationReason ?? "Consulte os detalhes do evento."),
          "Acompanhe o estado real do reembolso em sua conta. O cancelamento não significa que o estorno já foi concluído.",
        ],
        env().APP_URL + "/meus-pedidos",
      ),
    });
}

// Pedido de cancelamento com protocolo (R5): o comprador recebe o protocolo e o
// prazo ao abrir e a resposta quando a plataforma decide. Ao desistir, nada: foi ele.
export async function enqueueCancellationRequestReceivedTx(tx: Tx, requestId: string) {
  const r = await tx.cancellationRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { order: { select: { id: true, publicCode: true, buyerEmail: true } }, event: { select: { title: true, timezone: true } } },
  });
  await enqueueEmail(tx, {
    dedupeKey: "cancellation-request:" + r.id,
    template: "CANCELLATION_REQUEST_RECEIVED",
    recipient: r.order.buyerEmail,
    message: transactionalEmail(
      "cancellation",
      "Recebemos seu pedido de cancelamento",
      [
        r.event.title,
        "Pedido " + r.order.publicCode,
        "Protocolo: " + r.protocol,
        ...(r.respondBy
          ? ["Responderemos até " + formatDateTimeShort(r.respondBy, r.event.timezone) + " (horário do evento)."]
          : []),
        "Seus ingressos continuam como estão até a resposta. Guarde o protocolo para falar com o atendimento.",
      ],
      env().APP_URL + "/pedido/" + r.order.id,
    ),
  });
}

export async function enqueueCancellationDecisionTx(tx: Tx, requestId: string, outcome: CancellationOutcome) {
  const r = await tx.cancellationRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { order: { select: { id: true, publicCode: true, buyerEmail: true, totalCents: true } }, event: { select: { title: true } } },
  });
  if (r.status !== "APPROVED" && r.status !== "REJECTED") return;
  const approved = r.status === "APPROVED";
  const result = approved
    ? outcome === "REFUND_OPENED"
      ? "Abrimos o reembolso integral de " + formatBRL(r.order.totalCents) + ". Os ingressos foram cancelados. Você receberá outro e-mail quando o estorno for confirmado."
      : outcome === "PENDING_ORDER_CANCELLED"
        ? "O pedido ainda não estava pago: a reserva foi cancelada e nada foi cobrado."
        : "Este pedido já tinha um reembolso em andamento ou concluído; acompanhe o estado na página do pedido."
    : "Seus ingressos continuam válidos.";
  await enqueueEmail(tx, {
    dedupeKey: "cancellation-decision:" + r.id,
    template: approved ? "CANCELLATION_APPROVED" : "CANCELLATION_REJECTED",
    recipient: r.order.buyerEmail,
    message: transactionalEmail(
      "cancellation",
      approved ? "Pedido de cancelamento aprovado" : "Pedido de cancelamento recusado",
      [
        r.event.title,
        "Pedido " + r.order.publicCode,
        "Protocolo: " + r.protocol,
        ...(r.decisionNote ? ["Resposta: " + r.decisionNote] : []),
        result,
      ],
      env().APP_URL + "/pedido/" + r.order.id,
    ),
  });
}

// Reembolso que falhou e o admin desfez: o pedido volta a pago e os ingressos voltam
// a valer. Sem avisar, o comprador acharia que perdeu os ingressos (e não iria).
// A observação do admin é interna e não vai no e-mail.
export async function enqueueRefundRestoredEmailTx(tx: Tx, refundId: string) {
  const refund = await tx.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { order: { include: { event: { select: { title: true } } } } },
  });
  const o = refund.order;
  if (refund.status !== "REJECTED" || o.status !== "PAID") return;
  await enqueueEmail(tx, {
    dedupeKey: "refund-restored:" + refund.id,
    template: "REFUND_RESTORED",
    recipient: o.buyerEmail,
    message: transactionalEmail(
      "refund",
      "Seus ingressos voltaram a valer",
      [
        o.event.title,
        "Pedido " + o.publicCode,
        "Não foi possível concluir o reembolso deste pedido, então ele não foi feito e nenhum valor foi devolvido.",
        "O pedido voltou a ficar pago e seus ingressos são válidos de novo, com o mesmo QR code.",
        "Se ainda quiser o reembolso, você pode pedir de novo na página do pedido ou falar com o atendimento.",
      ],
      env().APP_URL + "/pedido/" + o.id,
    ),
  });
}

// Reembolso que parou de ser tentado sozinho (tentativas automáticas esgotadas ou
// bloqueio) e aguarda a equipe: os ingressos já foram cancelados e o dinheiro ainda
// não voltou. Um aviso por reembolso: nova falha após reprocessamento não repete.
// O motivo técnico da falha não vai no e-mail.
export async function enqueueRefundDelayedEmailTx(tx: Tx, refundId: string) {
  const refund = await tx.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { order: { include: { event: { select: { title: true } } } } },
  });
  const o = refund.order;
  if (refund.status !== "FAILED" || o.status !== "REFUND_PENDING") return;
  await enqueueEmail(tx, {
    dedupeKey: "refund-delayed:" + refund.id,
    template: "REFUND_DELAYED",
    recipient: o.buyerEmail,
    message: transactionalEmail(
      "refund",
      "Seu reembolso está demorando",
      [
        o.event.title,
        "Pedido " + o.publicCode,
        "Valor: " + formatBRL(refund.amountCents),
        "Não conseguimos concluir o estorno com o meio de pagamento, e nenhum valor foi devolvido ainda.",
        "Nossa equipe já foi avisada e vai resolver; você não precisa fazer nada nem pedir de novo.",
        "Os ingressos deste pedido continuam cancelados. Você receberá outro e-mail quando houver uma resposta.",
      ],
      env().APP_URL + "/pedido/" + o.id,
    ),
  });
}
