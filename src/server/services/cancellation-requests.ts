// Pedido de cancelamento com protocolo (R5, Decreto 13.108/2026; L5b).
//
// O comprador abre um pedido para qualquer pedido seu, com motivo; recebe um
// protocolo legível (CAN-AAAAMMDD-XXXXXX) e um prazo de resposta. O admin
// aprova (segue o caminho normal de reembolso, sob as mesmas travas) ou recusa
// com motivo. A linha decidida fica congelada no banco (gatilho
// CancellationRequest_guard); um pedido aberto por pedido (índice parcial).
import "server-only";
import type { CancellationRequestStatus } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db } from "../db";
import { audit } from "../audit";
import { enqueueCancellationDecisionTx, enqueueCancellationRequestReceivedTx } from "../email/events";
import { assertActive, type Actor, assertAdminPermission } from "../auth/permissions";
import { randomCode } from "../crypto";
import { AppError, forbidden, invalidState, notFound } from "../errors";
import type { PaymentProviderAdapter } from "../payments/types";
import { financeLog } from "./finance-log";
import { lockEvent, lockOrder, releaseOrderTx } from "./orders";
import { createRefundRequestTx, openChangeRefundWindow, processRefund, refundEligibility } from "./refunds";

/**
 * PADRÃO PROVISÓRIO (D3, pendente de decisão jurídica): prazo, em dias corridos,
 * para a plataforma responder a um pedido de cancelamento. Não é prazo legal.
 */
export const PROVISIONAL_CANCELLATION_RESPONSE_DAYS = 5;

const REASON_MAX = 2000;
const NOTE_MAX = 2000;
const PROTOCOL_ATTEMPTS = 5;

/** Data local de São Paulo (UTC−3, sem horário de verão) no formato AAAAMMDD. */
function localDateStamp(now: Date) {
  return new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 10).replaceAll("-", "");
}

/** CAN-AAAAMMDD-XXXXXX, base32 Crockford (sem I, L, O, U), como exige o CHECK do banco. */
export function newCancellationProtocol(now = new Date()) {
  return `CAN-${localDateStamp(now)}-${randomCode(6)}`;
}

const uniqueTarget = (err: Prisma.PrismaClientKnownRequestError) => JSON.stringify(err.meta ?? {});

export async function createCancellationRequest(db: Db, actor: Actor, orderId: string, reason: string, now = new Date()) {
  assertActive(actor);
  const text = reason.trim();
  if (!text) throw new AppError("VALIDATION", "Conte o motivo do pedido de cancelamento.");
  if (text.length > REASON_MAX) throw new AppError("VALIDATION", `O motivo pode ter até ${REASON_MAX} caracteres.`);
  const order = await db.order.findUnique({ where: { id: orderId }, include: { event: true, tickets: { select: { status: true } } } });
  if (!order) throw notFound("Pedido não encontrado.");
  if (order.userId !== actor.id) throw forbidden();

  // Registro para o SAC: o pedido já seria reembolsável sozinho? (não decide nada)
  const window = await openChangeRefundWindow(db, order.eventId, order.paidAt, now);
  const autoEligibleAtRequest = refundEligibility(order, order.event, order.tickets, now, window).eligible;
  const respondBy = new Date(now.getTime() + PROVISIONAL_CANCELLATION_RESPONSE_DAYS * 86_400_000);

  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const request = await tx.cancellationRequest.create({
          data: {
            protocol: newCancellationProtocol(now),
            orderId,
            eventId: order.eventId,
            organizationId: order.organizationId,
            requestedById: actor.id,
            reason: text,
            respondBy,
            autoEligibleAtRequest,
            createdAt: now,
          },
        });
        await audit(tx, {
          actorUserId: actor.id,
          organizationId: order.organizationId,
          action: "cancellation.requested",
          entityType: "CancellationRequest",
          entityId: request.id,
          metadata: { protocol: request.protocol, orderId, autoEligibleAtRequest, respondBy: respondBy.toISOString() },
        });
        await enqueueCancellationRequestReceivedTx(tx, request.id);
        return request;
      }, TX_OPTIONS);
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      if (uniqueTarget(err).includes("protocol") && attempt < PROTOCOL_ATTEMPTS) continue;
      const open = await db.cancellationRequest.findFirst({ where: { orderId, status: "OPEN" }, select: { protocol: true } });
      if (open) throw invalidState(`Já existe um pedido de cancelamento em análise para este pedido (protocolo ${open.protocol}).`);
      throw err;
    }
  }
}

/** Pedidos de cancelamento do comprador, mais recentes primeiro. */
export async function listMyCancellationRequests(db: Db, actor: Actor) {
  return db.cancellationRequest.findMany({
    where: { requestedById: actor.id },
    include: { order: { select: { publicCode: true, status: true } }, event: { select: { title: true, startsAt: true } } },
    orderBy: { createdAt: "desc" },
  });
}

/** Fila do admin: por padrão os abertos, do prazo mais curto para o mais longo. */
export async function listCancellationRequestsForAdmin(db: Db, admin: Actor, opts: { status?: CancellationRequestStatus; take?: number } = {}) {
  assertAdminPermission(admin, "cancellations:decide");
  const status = opts.status ?? "OPEN";
  return db.cancellationRequest.findMany({
    where: { status },
    include: {
      order: { select: { publicCode: true, status: true, totalCents: true, paidAt: true } },
      event: { select: { title: true, startsAt: true, status: true } },
      requestedBy: { select: { name: true, email: true } },
      refunds: { select: { id: true, status: true, amountCents: true }, orderBy: { createdAt: "desc" } },
    },
    orderBy: status === "OPEN" ? [{ respondBy: "asc" }, { createdAt: "asc" }] : [{ decidedAt: "desc" }],
    take: Math.min(opts.take ?? 100, 500),
  });
}

/** O comprador desiste do próprio pedido de cancelamento enquanto aberto. */
export async function withdrawCancellationRequest(db: Db, actor: Actor, requestId: string, now = new Date()) {
  assertActive(actor);
  const request = await db.cancellationRequest.findUnique({ where: { id: requestId } });
  if (!request) throw notFound("Pedido de cancelamento não encontrado.");
  if (request.requestedById !== actor.id) throw forbidden();
  return db.$transaction(async (tx) => {
    const claimed = await tx.cancellationRequest.updateMany({
      where: { id: requestId, status: "OPEN" },
      data: { status: "WITHDRAWN", decidedById: actor.id, decidedAt: now },
    });
    if (!claimed.count) throw invalidState("Este pedido de cancelamento já foi respondido.");
    await audit(tx, { actorUserId: actor.id, organizationId: request.organizationId, action: "cancellation.withdrawn", entityType: "CancellationRequest", entityId: requestId, metadata: { protocol: request.protocol } });
    return tx.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } });
  }, TX_OPTIONS);
}

export type CancellationDecision = { decision: "APPROVE"; note?: string } | { decision: "REJECT"; note: string };

/** O que a aprovação fez com o pedido. */
export type CancellationOutcome =
  | "REFUND_OPENED" // pedido pago: reembolso integral aberto (motivo ADMIN) e enviado ao provedor
  | "REFUND_ALREADY_EXISTS" // já havia reembolso em curso ou concluído: nenhum novo
  | "PENDING_ORDER_CANCELLED" // pedido ainda não pago: reserva liberada
  | "NONE"; // recusado

/**
 * Decisão do admin. Aprovar e recusar disputam a mesma transição condicional
 * `OPEN → decidido` sob as travas Event → Order, as mesmas de
 * `requestCustomerRefund`: aprovar duas vezes, ou aprovar enquanto o comprador
 * pede o reembolso normal, nunca gera dois reembolsos.
 */
export async function decideCancellationRequest(
  db: Db,
  adapter: PaymentProviderAdapter,
  admin: Actor,
  requestId: string,
  input: CancellationDecision,
  now = new Date(),
) {
  assertAdminPermission(admin, "cancellations:decide");
  const note = input.note?.trim() ?? "";
  if (input.decision === "REJECT" && !note) throw new AppError("VALIDATION", "Informe o motivo da recusa: ele é enviado ao comprador.");
  if (note.length > NOTE_MAX) throw new AppError("VALIDATION", `A justificativa pode ter até ${NOTE_MAX} caracteres.`);
  const ref = await db.cancellationRequest.findUnique({ where: { id: requestId }, select: { orderId: true, eventId: true } });
  if (!ref) throw notFound("Pedido de cancelamento não encontrado.");

  const result = await db.$transaction(async (tx) => {
    await lockEvent(tx, ref.eventId);
    await lockOrder(tx, ref.orderId);
    const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const claimed = await tx.cancellationRequest.updateMany({
      where: { id: requestId, status: "OPEN" },
      data: { status, decidedById: admin.id, decidedAt: now, decisionNote: note || null },
    });
    if (!claimed.count) throw invalidState("Este pedido de cancelamento já foi decidido.");
    const request = await tx.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } });
    const order = await tx.order.findUniqueOrThrow({ where: { id: ref.orderId }, select: { status: true } });

    let outcome: CancellationOutcome = "NONE";
    let refundId: string | null = null;
    if (input.decision === "APPROVE") {
      if (order.status === "PAID") {
        const refund = await createRefundRequestTx(tx, ref.orderId, "ADMIN", admin.id, {
          note: `Pedido de cancelamento ${request.protocol}${note ? `: ${note}` : ""}`.slice(0, 1000),
          cancellationRequestId: requestId,
        });
        outcome = "REFUND_OPENED";
        refundId = refund.id;
      } else if (order.status === "REFUND_PENDING" || order.status === "REFUNDED") {
        outcome = "REFUND_ALREADY_EXISTS";
        refundId = (await tx.refund.findFirst({ where: { orderId: ref.orderId, status: { not: "REJECTED" } }, orderBy: { createdAt: "desc" }, select: { id: true } }))?.id ?? null;
      } else if (order.status === "PENDING_PAYMENT") {
        await releaseOrderTx(tx, ref.orderId, "CANCELLED", "cancellation_request_approved", now);
        outcome = "PENDING_ORDER_CANCELLED";
      } else {
        throw invalidState(`O pedido está ${order.status} e não tem valor a reembolsar: recuse informando o motivo.`);
      }
    }
    await audit(tx, {
      actorUserId: admin.id,
      organizationId: request.organizationId,
      action: input.decision === "APPROVE" ? "cancellation.approved" : "cancellation.rejected",
      entityType: "CancellationRequest",
      entityId: requestId,
      metadata: { protocol: request.protocol, orderId: ref.orderId, outcome, refundId, note: note || null },
    });
    await enqueueCancellationDecisionTx(tx, requestId, outcome);
    return { request, outcome, refundId };
  }, TX_OPTIONS);

  financeLog("info", `cancellation.${input.decision === "APPROVE" ? "approved" : "rejected"}`, { orderId: ref.orderId }, { requestId, outcome: result.outcome, adminId: admin.id });
  // Como nos demais reembolsos: o provedor é chamado fora da transação, com chave de idempotência.
  if (result.outcome === "REFUND_OPENED" && result.refundId) await processRefund(db, adapter, result.refundId);
  return result;
}
