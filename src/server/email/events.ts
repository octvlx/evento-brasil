import "server-only";
import type { Db, Tx } from "../db";
import { env } from "../env";
import { enqueueEmail } from "./outbox";
import { transactionalEmail } from "./templates";
import { formatBRL } from "@/lib/money";
import { ORGANIZER_REVIEW_AREA, ORGANIZER_REVIEW_AREA_HINT } from "@/lib/labels";
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
        "Valor: " + formatBRL(refund.amountCents) + (refund.partial ? " (reembolso parcial; os demais ingressos do pedido seguem válidos)" : ""),
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
        refund.partial ? "Os ingressos deste reembolso são válidos de novo, com o mesmo QR code." : "O pedido voltou a ficar pago e seus ingressos são válidos de novo, com o mesmo QR code.",
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
  if (refund.status !== "FAILED" || !(o.status === "REFUND_PENDING" || (refund.partial && o.status === "PAID"))) return;
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
        refund.partial
          ? "Os ingressos deste reembolso continuam cancelados; os demais do pedido seguem válidos. Você receberá outro e-mail quando houver uma resposta."
          : "Os ingressos deste pedido continuam cancelados. Você receberá outro e-mail quando houver uma resposta.",
      ],
      env().APP_URL + "/pedido/" + o.id,
    ),
  });
}

// Reembolso manual do admin acima do limite, aguardando aprovação. Quem aprova (OWNER e
// FINANCE da organização) recebe o pedido; o comprador fica sabendo que os ingressos
// estão bloqueados até a decisão. A observação interna do admin vai só para a equipe.
export async function enqueueRefundApprovalRequestedEmailsTx(tx: Tx, refundId: string) {
  const refund = await tx.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { order: { include: { event: { select: { title: true } } } }, _count: { select: { tickets: true } } },
  });
  if (refund.status !== "AWAITING_APPROVAL") return;
  const o = refund.order;
  const approvers = await tx.organizationMember.findMany({
    where: { organizationId: o.organizationId, role: { in: ["OWNER", "FINANCE"] }, user: { status: "ACTIVE" } },
    select: { user: { select: { email: true } } },
  });
  for (const email of new Set(approvers.map((m) => m.user.email))) {
    await enqueueEmail(tx, {
      dedupeKey: "refund-approval:" + refund.id + ":" + email,
      template: "REFUND_APPROVAL_REQUESTED",
      recipient: email,
      message: transactionalEmail(
        "approval",
        "Reembolso aguardando sua aprovação",
        [
          o.event.title,
          "Pedido " + o.publicCode,
          "Valor: " + formatBRL(refund.amountCents) + (refund.partial ? " (reembolso parcial, " + refund._count.tickets + " ingresso(s))" : ""),
          "A equipe da plataforma pediu este reembolso" + (refund.note ? ". Motivo informado: " + refund.note : "."),
          "Os ingressos deste reembolso já estão bloqueados. Nada é devolvido até alguém aprovar; se você recusar, eles voltam a valer.",
        ],
        env().APP_URL + "/organizador/reembolsos",
      ),
    });
  }
  await enqueueEmail(tx, {
    dedupeKey: "refund-awaiting:" + refund.id,
    template: "REFUND_AWAITING_APPROVAL",
    recipient: o.buyerEmail,
    message: transactionalEmail(
      "refund",
      "Seu reembolso está em análise",
      [
        o.event.title,
        "Pedido " + o.publicCode,
        "Valor: " + formatBRL(refund.amountCents),
        "O reembolso foi aberto e aguarda a aprovação do organizador antes de ser enviado ao meio de pagamento.",
        refund.partial
          ? "Enquanto isso, os ingressos deste reembolso ficam bloqueados; os demais do pedido seguem válidos."
          : "Enquanto isso, os ingressos deste pedido ficam bloqueados.",
        "Você receberá outro e-mail com a decisão.",
      ],
      env().APP_URL + "/pedido/" + o.id,
    ),
  });
}

// Reembolso recusado na aprovação: o pedido volta a pago e os ingressos voltam a valer.
// O motivo da recusa é da equipe e do organizador; não vai no e-mail.
export async function enqueueRefundApprovalRejectedEmailTx(tx: Tx, refundId: string) {
  const refund = await tx.refund.findUniqueOrThrow({
    where: { id: refundId },
    include: { order: { include: { event: { select: { title: true } } } } },
  });
  const o = refund.order;
  if (refund.status !== "REJECTED" || !refund.approvalRequired || o.status !== "PAID") return;
  await enqueueEmail(tx, {
    dedupeKey: "refund-approval-rejected:" + refund.id,
    template: "REFUND_APPROVAL_REJECTED",
    recipient: o.buyerEmail,
    message: transactionalEmail(
      "refund",
      "Seus ingressos voltaram a valer",
      [
        o.event.title,
        "Pedido " + o.publicCode,
        "O reembolso deste pedido não foi aprovado, e nenhum valor foi devolvido.",
        refund.partial ? "Os ingressos deste reembolso são válidos de novo, com o mesmo QR code." : "O pedido voltou a ficar pago e seus ingressos são válidos de novo, com o mesmo QR code.",
        "Se tiver dúvidas, fale com o atendimento.",
      ],
      env().APP_URL + "/pedido/" + o.id,
    ),
  });
}

// Evento suspenso (ou reativado) pela plataforma: avisa o responsável e o financeiro
// da organização. Compradores não são avisados: os ingressos continuam valendo.
export async function enqueueEventSuspensionEmailsTx(tx: Tx, eventId: string, suspended: boolean, reason: string | null) {
  const event = await tx.event.findUniqueOrThrow({ where: { id: eventId }, select: { id: true, title: true, organizationId: true, suspendedAt: true } });
  const members = await tx.organizationMember.findMany({
    where: { organizationId: event.organizationId, role: { in: ["OWNER", "FINANCE"] }, user: { status: "ACTIVE" } },
    select: { user: { select: { email: true } } },
  });
  // Uma suspensão por instante: suspender de novo depois de reativar gera outro aviso.
  const stamp = suspended ? (event.suspendedAt?.getTime() ?? Date.now()) : Date.now();
  for (const email of new Set(members.map((m) => m.user.email))) {
    await enqueueEmail(tx, {
      dedupeKey: `event-${suspended ? "suspended" : "reinstated"}:${event.id}:${stamp}:${email}`,
      template: suspended ? "EVENT_SUSPENDED" : "EVENT_REINSTATED",
      recipient: email,
      message: transactionalEmail(
        "event",
        suspended ? "Evento suspenso pela plataforma" : "Evento reativado",
        suspended
          ? [
              event.title,
              "Motivo: " + (reason ?? "—"),
              "O evento saiu das buscas e da página pública e as vendas foram pausadas. Os ingressos já vendidos continuam valendo, inclusive na portaria.",
              "Enquanto estiver suspenso, o evento não pode ser editado. Fale com o suporte para resolver.",
            ]
          : [event.title, "O evento voltou para a vitrine e as vendas foram retomadas (dentro do período de vendas configurado)."],
        env().APP_URL + "/organizador/eventos/" + event.id + "/editar",
      ),
    });
  }
}

// Decisão do admin sobre o cadastro de organizador: avisa os responsáveis (OWNER)
// ativos. Um aviso por envio do cadastro (a verificação é nova a cada reenvio).
export async function enqueueOrganizationReviewEmailsTx(
  tx: Tx,
  organizationId: string,
  decision: "APPROVE" | "REJECT",
  note: string | null,
  verificationId: string | null,
) {
  const approved = decision === "APPROVE";
  // Lido depois da decisão (mesma transação): a área da recusa já está gravada.
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { id: true, name: true, statusReasonArea: true } });
  const area = !approved && org.statusReasonArea && org.statusReasonArea !== "OTHER" ? org.statusReasonArea : null;
  const owners = await tx.organizationMember.findMany({
    where: { organizationId, role: "OWNER", user: { status: "ACTIVE" } },
    select: { user: { select: { email: true } } },
  });
  const submission = verificationId ?? `${org.id}:${Date.now()}`;
  for (const email of new Set(owners.map((m) => m.user.email))) {
    await enqueueEmail(tx, {
      dedupeKey: `organization-review:${submission}:${decision}:${email}`,
      template: approved ? "ORGANIZATION_APPROVED" : "ORGANIZATION_REJECTED",
      recipient: email,
      message: transactionalEmail(
        "organizer",
        approved ? "Cadastro aprovado" : "Seu cadastro precisa de ajustes",
        approved
          ? [
              `${org.name} foi aprovada para vender ingressos.`,
              "Você já pode publicar eventos pelo painel do organizador.",
              "Para receber os repasses das vendas, conecte sua conta do Mercado Pago em Configurações.",
            ]
          : [
              `O cadastro de ${org.name} não foi aprovado desta vez.`,
              "Motivo: " + (note?.trim() || "—"),
              ...(area ? [`Ajuste pedido em ${ORGANIZER_REVIEW_AREA[area]} (${ORGANIZER_REVIEW_AREA_HINT[area]}). O reenvio abre direto nessa parte.`] : []),
              "Corrija os dados e envie de novo para análise.",
            ],
        env().APP_URL + (approved ? "/organizador" : "/organizador/cadastro"),
      ),
    });
  }
}
