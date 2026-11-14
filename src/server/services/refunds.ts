// Reembolsos por ingresso. Integral: cobre todos os ingressos ainda não reembolsados
// e leva o pedido a REFUND_PENDING/REFUNDED. Parcial (`Refund.partial`): cobre só os
// ingressos escolhidos; o pedido continua PAID com os demais válidos. Cada ingresso
// aponta para o reembolso que o cobre (`IssuedTicket.refundId`). Valor por ingresso:
// preço pago (com desconto) + taxa de serviço; a comissão segue a regra do pedido.
// Regras em docs/areas/financeiro.md (Pendências, item 3).
import "server-only";
import { enqueueRefundDelayedEmailTx, enqueueRefundEmailTx, enqueueRefundRestoredEmailTx } from "../email/events";
import type { Prisma, RefundReason, RefundStatus } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { assertActive, type Actor, assertAdminPermission } from "../auth/permissions";
import { AppError, forbidden, invalidState, notFound } from "../errors";
import { VALID_PAID_PAYMENTS, type PaymentProviderAdapter } from "../payments/types";
import { financeLog } from "./finance-log";
import { postReversal } from "./ledger";
import { lockEvent, lockOrder } from "./orders";

/** Padrões da política de reembolso de um evento novo (iguais aos defaults do banco). */
export const DEFAULT_REFUND_POLICY = { refundWindowDays: 7, refundMinHoursBeforeEvent: 48 } as const;

/** Janela de reembolso integral aberta por uma alteração relevante do evento (R8). */
export interface ChangeRefundWindow {
  /** Alteração que abriu a janela (a original, mesmo quando a janela vem de uma prorrogação). */
  eventChangeId: string;
  /** Linha que concede o prazo vigente (a própria alteração ou a prorrogação mais longa). */
  grantedById: string;
  changedAt: Date;
  refundUntil: Date;
}

const dateTimeBR = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" });

/**
 * Janela de reembolso integral aberta para um pedido pago em `paidAt`: alteração
 * relevante (`relevant = true`) do evento registrada DEPOIS do pagamento, com
 * `now <= refundUntil`. Uma prorrogação (`extendsChangeId`) vale para os mesmos
 * pedidos da alteração original. Havendo várias, vence o prazo mais longo.
 * O que é "relevante" e o tamanho da janela são decididos por `area-organizador` (D2).
 */
export async function openChangeRefundWindow(client: Db | Tx, eventId: string, paidAt: Date | null, now = new Date()): Promise<ChangeRefundWindow | null> {
  if (!paidAt) return null;
  const rows = await client.eventChange.findMany({
    where: { eventId },
    select: { id: true, relevant: true, refundUntil: true, createdAt: true, extendsChangeId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const root = (r: (typeof rows)[number]) => {
    let cur = r;
    for (let hops = 0; cur.extendsChangeId && hops < rows.length; hops++) {
      const parent = byId.get(cur.extendsChangeId);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  };
  let best: ChangeRefundWindow | null = null;
  for (const r of rows) {
    if (!r.refundUntil || now.getTime() > r.refundUntil.getTime()) continue;
    const origin = root(r);
    if (origin.relevant !== true || paidAt.getTime() >= origin.createdAt.getTime()) continue;
    if (!best || r.refundUntil > best.refundUntil) {
      best = { eventChangeId: origin.id, grantedById: r.id, changedAt: origin.createdAt, refundUntil: r.refundUntil };
    }
  }
  return best;
}

export type RefundEligibility =
  | { eligible: true; basis: "EVENT_POLICY" }
  | { eligible: true; basis: "EVENT_CHANGED"; window: ChangeRefundWindow; message: string }
  | { eligible: false; reason: string };

/**
 * Elegibilidade para reembolso solicitado pelo comprador.
 *
 * - Com janela de alteração relevante aberta (`changeWindow`, de
 *   `openChangeRefundWindow`): reembolso integral, taxas incluídas,
 *   independentemente dos prazos normais do evento (R8).
 * - Senão, pela política do próprio evento: até `refundWindowDays` dias após a
 *   compra E até `refundMinHoursBeforeEvent` horas antes do início.
 *
 * PRECISA de revisão jurídica (CDC art. 49, Decreto 13.108/2026 e normas aplicáveis a eventos).
 */
export function refundEligibility(
  order: { status: string; paidAt: Date | null; totalCents: number },
  event: { startsAt: Date; status: string; refundWindowDays: number; refundMinHoursBeforeEvent: number },
  tickets: { status: string }[],
  now: Date,
  changeWindow: ChangeRefundWindow | null = null,
): RefundEligibility {
  if (order.status !== "PAID") return { eligible: false, reason: "Somente pedidos pagos podem ser reembolsados." };
  if (event.status === "CANCELLED") return { eligible: false, reason: "Evento cancelado: o reembolso é processado automaticamente." };
  if (tickets.some((t) => t.status === "CHECKED_IN")) return { eligible: false, reason: "Há ingressos já utilizados neste pedido." };
  if (changeWindow && now.getTime() <= changeWindow.refundUntil.getTime()) {
    return {
      eligible: true,
      basis: "EVENT_CHANGED",
      window: changeWindow,
      message: `O evento foi alterado depois da sua compra: você pode pedir o reembolso integral, com as taxas, até ${dateTimeBR.format(changeWindow.refundUntil)}.`,
    };
  }
  if (!order.paidAt || now.getTime() - order.paidAt.getTime() > event.refundWindowDays * 86_400_000)
    return { eligible: false, reason: `O prazo de ${event.refundWindowDays} ${event.refundWindowDays === 1 ? "dia" : "dias"} após a compra terminou.` };
  if (event.startsAt.getTime() - now.getTime() < event.refundMinHoursBeforeEvent * 3_600_000)
    return { eligible: false, reason: `Reembolsos só até ${event.refundMinHoursBeforeEvent}h antes do evento.` };
  return { eligible: true, basis: "EVENT_POLICY" };
}

/**
 * Soma dos reembolsos do pedido que já comprometem o valor pago (exceto `excludeId`).
 * Invariante: reembolsos bem-sucedidos/em curso ≤ valor pago do pedido.
 */
async function committedRefundCents(client: Db | Tx, orderId: string, statuses: RefundStatus[], excludeId?: string) {
  const agg = await client.refund.aggregate({
    where: { orderId, status: { in: statuses }, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

export class OverRefundError extends Error {}

/** Reembolsos ainda não terminados: enquanto existir um, o pedido não aceita outro. */
const OPEN_REFUND_STATUSES: RefundStatus[] = ["REQUESTED", "PROCESSING", "FAILED"];

/**
 * Reembolsos FAILED que aguardam reprocessamento ou decisão do admin: integrais
 * (pedido em REFUND_PENDING) e parciais (o pedido segue PAID).
 */
export const AWAITING_REFUND_WHERE: Prisma.RefundWhereInput = {
  status: "FAILED",
  OR: [{ order: { status: "REFUND_PENDING" } }, { partial: true, order: { status: "PAID" } }],
};

/** O pedido ainda espera este reembolso (o integral deixa o pedido em REFUND_PENDING; o parcial, em PAID). */
export function orderAwaitsRefund(refund: { partial: boolean }, orderStatus: string) {
  return orderStatus === "REFUND_PENDING" || (refund.partial && orderStatus === "PAID");
}

/** Valores dos ingressos: preço pago + taxa de serviço, taxa e comissão (a comissão inclui a taxa). */
export async function ticketRefundAmounts(client: Db | Tx, where: Prisma.IssuedTicketWhereInput) {
  const tickets = await client.issuedTicket.findMany({
    where,
    select: { id: true, ticketTypeId: true, orderItem: { select: { unitPriceCents: true, serviceFeePerUnitCents: true, commissionPerUnitCents: true } } },
  });
  let totalCents = 0;
  let serviceFeeCents = 0;
  let commissionCents = 0;
  for (const t of tickets) {
    totalCents += t.orderItem.unitPriceCents + t.orderItem.serviceFeePerUnitCents;
    serviceFeeCents += t.orderItem.serviceFeePerUnitCents;
    commissionCents += t.orderItem.commissionPerUnitCents;
  }
  return { tickets, totalCents, serviceFeeCents, commissionCents };
}

/** Soma dos reembolsos parciais do pedido que não foram desfeitos (exceto `excludeId`). */
export async function partialRefundCents(client: Db | Tx, orderId: string, excludeId?: string) {
  const agg = await client.refund.aggregate({
    where: { orderId, partial: true, status: { not: "REJECTED" }, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

/** Motivos pedidos pelo comprador: ingresso já usado impede o reembolso. */
const BUYER_REASONS: RefundReason[] = ["CUSTOMER_REQUEST", "EVENT_CHANGED"];

/**
 * Encerra as transferências pendentes de ingressos que deixaram de valer (reembolso,
 * chargeback, evento cancelado): CANCELLED, com `decidedById` nulo (automático). O
 * aceite já seria recusado (ingresso não VALID), mas o convite seguiria "pendente"
 * para as duas pessoas até vencer. Pré-condição: travas Event → Order (a ordem de
 * transfers.ts: Event → Order → IssuedTicket → TicketTransfer).
 */
export async function closePendingTransfersTx(tx: Tx, scope: { orderId: string } | { eventId: string } | { ticketIds: string[] }, reason: string, now = new Date()) {
  if ("ticketIds" in scope && !scope.ticketIds.length) return 0;
  const where: Prisma.TicketTransferWhereInput =
    "orderId" in scope ? { ticket: { orderId: scope.orderId } } : "eventId" in scope ? { eventId: scope.eventId } : { ticketId: { in: scope.ticketIds } };
  const { count } = await tx.ticketTransfer.updateMany({
    where: { status: "PENDING", ...where },
    data: { status: "CANCELLED", decidedAt: now, decisionReason: reason },
  });
  return count;
}

export interface RefundRequestLinks {
  note?: string;
  eventChangeId?: string;
  cancellationRequestId?: string;
}

/**
 * Abre o reembolso de um pedido pago. Sem `ticketIds`, cobre todos os ingressos
 * ainda não reembolsados (integral). Com `ticketIds`, só esses; se forem todos os
 * que restam, vira integral. Pré-condição: travas do evento e do pedido (nessa
 * ordem). Recusa se o pedido não está PAID ou se já há reembolso em aberto — é a
 * guarda contra reembolso em dobro.
 */
export async function createRefundRequestTx(
  tx: Tx,
  orderId: string,
  reason: RefundReason,
  requestedById: string | null,
  links: RefundRequestLinks = {},
  ticketIds?: string[],
) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: VALID_PAID_PAYMENTS } });
  if (order.status !== "PAID") throw invalidState("Pedido não está pago.");
  if (await tx.refund.count({ where: { orderId, status: { in: OPEN_REFUND_STATUSES } } })) {
    throw invalidState("Este pedido já tem um reembolso em andamento.");
  }
  // Ingressos que ainda podem ser cobertos por um reembolso.
  const open = await tx.issuedTicket.findMany({ where: { orderId, refundId: null, status: { in: ["VALID", "CHECKED_IN"] } }, select: { id: true, status: true } });
  let selected = open.map((t) => t.id);
  let partial = false;
  if (ticketIds) {
    const ids = [...new Set(ticketIds)];
    if (!ids.length) throw new AppError("VALIDATION", "Escolha ao menos um ingresso para reembolsar.");
    const byId = new Map(open.map((t) => [t.id, t]));
    for (const id of ids) {
      const t = byId.get(id);
      if (!t) throw new AppError("VALIDATION", "Um dos ingressos escolhidos não pode ser reembolsado neste pedido.");
      if (t.status === "CHECKED_IN") throw new AppError("VALIDATION", "Ingresso já utilizado não pode ser reembolsado.");
    }
    partial = ids.length < open.length;
    selected = ids;
  }
  const amountCents = partial
    ? (await ticketRefundAmounts(tx, { id: { in: selected } })).totalCents
    : order.totalCents - (await partialRefundCents(tx, orderId));

  // Um reembolso anterior com o mesmo motivo pode ter sido encerrado como
  // REJECTED (admin restaurou os ingressos): o novo pedido precisa de chave própria.
  // Parciais são numerados pela quantidade de reembolsos do pedido.
  let key: string;
  if (partial) {
    key = `refund:${orderId}:${reason.toLowerCase()}:partial:${(await tx.refund.count({ where: { orderId } })) + 1}`;
  } else {
    const rejected = await tx.refund.count({ where: { orderId, reason, status: "REJECTED", partial: false } });
    key = `refund:${orderId}:${reason.toLowerCase()}${rejected ? `:${rejected + 1}` : ""}`;
  }
  const refund = await tx.refund.upsert({
    where: { idempotencyKey: key },
    create: {
      orderId,
      paymentId: order.payments[0]?.id ?? null,
      amountCents,
      partial,
      reason,
      requestedById,
      note: links.note,
      eventChangeId: links.eventChangeId,
      cancellationRequestId: links.cancellationRequestId,
      idempotencyKey: key,
    },
    update: {},
  });
  // Revoga os ingressos AGORA, sob as travas: um check-in concorrente
  // (UPDATE … WHERE status='VALID') não consegue mais usar o ingresso, e um
  // check-in que chegou antes é detectado abaixo. Antes, a verificação era
  // feita fora da trava e o comprador podia entrar E ser reembolsado.
  // Vale também para ingressos transferidos: o dinheiro volta a quem pagou (D7).
  const now = new Date();
  await tx.issuedTicket.updateMany({ where: { id: { in: selected } }, data: { refundId: refund.id } });
  await tx.issuedTicket.updateMany({ where: { id: { in: selected }, status: "VALID" }, data: { status: "REVOKED", revokedAt: now, revocationReason: "REFUNDED" } });
  if (partial || BUYER_REASONS.includes(reason)) {
    const used = await tx.issuedTicket.count({ where: { id: { in: selected }, status: "CHECKED_IN" } });
    if (used > 0) throw new AppError("VALIDATION", partial ? "Ingresso já utilizado não pode ser reembolsado." : "Há ingressos já utilizados neste pedido.");
  }
  const transfersClosed = await closePendingTransfersTx(tx, partial ? { ticketIds: selected } : { orderId }, "Ingresso em reembolso", now);
  if (!partial) await tx.order.update({ where: { id: orderId }, data: { status: "REFUND_PENDING" } });
  await audit(tx, {
    actorUserId: requestedById,
    organizationId: order.organizationId,
    action: "refund.requested",
    entityType: "Refund",
    entityId: refund.id,
    metadata: {
      reason,
      ...(partial ? { partial: true, tickets: selected.length } : {}),
      ...(transfersClosed ? { transfersClosed } : {}),
      ...(links.eventChangeId ? { eventChangeId: links.eventChangeId } : {}),
      ...(links.cancellationRequestId ? { cancellationRequestId: links.cancellationRequestId } : {}),
    },
  });
  return refund;
}

async function createRefundRequest(db: Db, orderId: string, reason: RefundReason, requestedById: string | null, links?: RefundRequestLinks, ticketIds?: string[]) {
  return db.$transaction(async (tx) => {
    const ref = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { eventId: true } });
    await lockEvent(tx, ref.eventId);
    await lockOrder(tx, orderId);
    return createRefundRequestTx(tx, orderId, reason, requestedById, links, ticketIds);
  }, TX_OPTIONS);
}

/**
 * Reembolso pedido pelo comprador (quem pagou o pedido). Com janela de alteração
 * relevante aberta, o motivo é `EVENT_CHANGED` e o reembolso fica ligado à
 * alteração; senão vale a política normal do evento (`CUSTOMER_REQUEST`).
 * Com `ticketIds`, reembolsa só esses ingressos; os prazos são os mesmos, e um
 * ingresso já usado fora da escolha não impede o reembolso dos outros.
 */
export async function requestCustomerRefund(db: Db, adapter: PaymentProviderAdapter, actor: Actor, orderId: string, now = new Date(), ticketIds?: string[]) {
  assertActive(actor);
  const order = await db.order.findUnique({ where: { id: orderId }, include: { event: true, tickets: { select: { id: true, status: true } } } });
  if (!order) throw notFound();
  if (order.userId !== actor.id) throw forbidden();
  const window = await openChangeRefundWindow(db, order.eventId, order.paidAt, now);
  const tickets = ticketIds ? order.tickets.filter((t) => ticketIds.includes(t.id)) : order.tickets;
  const check = refundEligibility(order, order.event, tickets, now, window);
  if (!check.eligible) throw new AppError("VALIDATION", check.reason);
  const refund =
    check.basis === "EVENT_CHANGED"
      ? await createRefundRequest(db, orderId, "EVENT_CHANGED", actor.id, { eventChangeId: check.window.eventChangeId }, ticketIds)
      : await createRefundRequest(db, orderId, "CUSTOMER_REQUEST", actor.id, undefined, ticketIds);
  await processRefund(db, adapter, refund.id);
  return db.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** Reembolso pelo admin: o pedido inteiro ou, com `ticketIds`, só esses ingressos (não usados). */
export async function adminRefundOrder(db: Db, adapter: PaymentProviderAdapter, admin: Actor, orderId: string, note: string, ticketIds?: string[]) {
  assertAdminPermission(admin, "finance:refunds");
  if (!note.trim()) throw new AppError("VALIDATION", "Informe o motivo do reembolso.");
  const refund = await createRefundRequest(db, orderId, "ADMIN", admin.id, { note }, ticketIds);
  await processRefund(db, adapter, refund.id);
  return db.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** Solicita o estorno ao provedor. Confirma imediatamente se o provedor responder sucesso. */
export async function processRefund(db: Db, adapter: PaymentProviderAdapter, refundId: string) {
  const refund = await db.refund.findUnique({
    where: { id: refundId },
    include: { payment: true, order: { select: { organizationId: true } } },
  });
  if (!refund || !["REQUESTED", "FAILED"].includes(refund.status)) return refund;
  const claimed = await db.refund.updateMany({ where: { id: refundId, status: { in: ["REQUESTED", "FAILED"] } }, data: { status: "PROCESSING" } });
  if (!claimed.count) return refund;

  // Guarda contra estorno acima do valor pago, ANTES de chamar o provedor.
  const order = await db.order.findUniqueOrThrow({ where: { id: refund.orderId }, select: { totalCents: true } });
  const others = await committedRefundCents(db, refund.orderId, ["PROCESSING", "SUCCEEDED"], refundId);
  if (others + refund.amountCents > order.totalCents) {
    await recordRefundFailure(db, refund, "OVER_REFUND_BLOCKED", "soma de reembolsos excederia o valor pago.");
    return db.refund.findUnique({ where: { id: refundId } });
  }

  // Pedido gratuito ou sem pagamento no provedor: nada a estornar externamente.
  if (refund.amountCents === 0 || !refund.payment?.providerPaymentId || refund.payment.method === "FREE") {
    await db.$transaction((tx) => confirmRefundTxWithLocks(tx, refundId), TX_OPTIONS);
    return db.refund.findUnique({ where: { id: refundId } });
  }
  try {
    const result = await adapter.refundPayment({
      providerPaymentId: refund.payment.providerPaymentId,
      amountCents: refund.amountCents,
      idempotencyKey: refund.idempotencyKey,
      organizationId: refund.order.organizationId,
    });
    await db.refund.update({ where: { id: refundId }, data: { providerRefundId: result.providerRefundId } });
    if (result.status === "SUCCEEDED") await db.$transaction((tx) => confirmRefundTxWithLocks(tx, refundId), TX_OPTIONS);
    else if (result.status === "FAILED") await recordRefundFailure(db, refund, "PROVIDER_REFUSED", "Provedor recusou o estorno.");
    // PENDING: aguarda webhook do provedor.
  } catch (err) {
    await recordRefundFailure(db, refund, "PROVIDER_ERROR", `Erro no provedor: ${String(err).slice(0, 300)}`);
  }
  return db.refund.findUnique({ where: { id: refundId } });
}

// ───────────────────────────── Política para reembolso FAILED ─────────────────────────────
//
// Ao solicitar o reembolso os ingressos já são revogados (ver createRefundRequest).
// Se o provedor recusar ou falhar, o comprador ficaria sem dinheiro e sem ingresso,
// então a falha NUNCA é silenciosa:
//   1. cada falha é registrada (auditoria `refund.attempt_failed` + log com o id do pedido);
//   2. a manutenção (cron) reprocessa automaticamente, com a MESMA chave de
//      idempotência, até `maxAutomaticAttempts` tentativas, com espera crescente;
//   3. esgotadas as tentativas (ou bloqueio por estorno acima do pago), o reembolso
//      fica aguardando decisão do admin: reprocessar (`adminRetryRefund`) ou
//      restaurar os ingressos e voltar o pedido a PAID (`adminRestoreAfterFailedRefund`).
// As tentativas são contadas pelos registros de auditoria (sem coluna no schema).

export const REFUND_RETRY_POLICY = {
  /** Tentativas no provedor (incluindo a primeira) antes de exigir decisão do admin. */
  maxAutomaticAttempts: 4,
  /** Espera após a 1ª, 2ª e 3ª falha. */
  backoffMinutes: [5, 30, 120],
} as const;

type RefundFailureKind = "PROVIDER_REFUSED" | "PROVIDER_ERROR" | "OVER_REFUND_BLOCKED";

const ATTEMPT_FAILED = "refund.attempt_failed";

async function recordRefundFailure(db: Db, refund: { id: string; orderId: string }, kind: RefundFailureKind, message: string) {
  // Bloqueio por estorno acima do pago não é tentativa no provedor e nunca é reprocessado sozinho.
  const isAttempt = kind !== "OVER_REFUND_BLOCKED";
  const max = REFUND_RETRY_POLICY.maxAutomaticAttempts;
  const failure = await db.$transaction(async (tx) => {
    const ref = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId }, select: { eventId: true } });
    await lockEvent(tx, ref.eventId);
    await lockOrder(tx, refund.orderId);
    const current = await tx.refund.findUniqueOrThrow({ where: { id: refund.id } });
    if (current.status !== "PROCESSING" || current.processedAt) return null;
    const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId }, select: { organizationId: true } });
    const previous = await tx.auditLog.count({ where: { entityType: "Refund", entityId: refund.id, action: ATTEMPT_FAILED } });
    const attempt = previous + (isAttempt ? 1 : 0);
    const awaitingDecision = !isAttempt || attempt >= max;
    const note = isAttempt
      ? `${kind}: ${message} (tentativa ${attempt}, limite automático ${max}${awaitingDecision ? "; aguardando decisão do admin" : ""})`
      : `${kind}: ${message}`;
    await tx.refund.update({ where: { id: refund.id }, data: { status: "FAILED", note } });
    const base = { organizationId: order.organizationId, entityType: "Refund", entityId: refund.id };
    await audit(tx, { ...base, action: isAttempt ? ATTEMPT_FAILED : "refund.blocked", metadata: { orderId: refund.orderId, kind, attempt, message } });
    if (isAttempt && attempt === max) await audit(tx, { ...base, action: "refund.retry_exhausted", metadata: { orderId: refund.orderId, attempts: attempt } });
    // Parou de ser tentado sozinho: avisa o comprador (uma vez por reembolso).
    if (awaitingDecision) await enqueueRefundDelayedEmailTx(tx, refund.id);
    return { attempt, awaitingDecision };
  }, TX_OPTIONS);
  if (!failure) return;
  const { attempt, awaitingDecision } = failure;
  financeLog("error", awaitingDecision ? "refund.awaiting_admin_decision" : "refund.attempt_failed", { orderId: refund.orderId, refundId: refund.id }, { kind, attempt, message });
}

export interface RefundRetryState {
  /** Falhas registradas no provedor (automáticas e manuais). */
  attempts: number;
  /** Quando a manutenção vai tentar de novo; nulo se aguarda o admin. */
  nextRetryAt: Date | null;
  awaitingAdminDecision: boolean;
}

/** Estado de retentativa de reembolsos FAILED, calculado a partir da auditoria. */
export async function refundRetryStates(client: Db | Tx, refunds: { id: string; note: string | null; updatedAt: Date }[]) {
  const rows = refunds.length
    ? await client.auditLog.groupBy({
        by: ["entityId"],
        where: { entityType: "Refund", action: ATTEMPT_FAILED, entityId: { in: refunds.map((r) => r.id) } },
        _count: { _all: true },
        _max: { createdAt: true },
      })
    : [];
  const byId = new Map(rows.map((r) => [r.entityId, r]));
  const { maxAutomaticAttempts, backoffMinutes } = REFUND_RETRY_POLICY;
  return new Map(
    refunds.map((r): [string, RefundRetryState] => {
      const row = byId.get(r.id);
      const attempts = row?._count._all ?? 0;
      const blocked = r.note?.startsWith("OVER_REFUND_BLOCKED") ?? false;
      if (blocked || attempts >= maxAutomaticAttempts) return [r.id, { attempts, nextRetryAt: null, awaitingAdminDecision: true }];
      const last = row?._max.createdAt ?? r.updatedAt;
      const wait = backoffMinutes[Math.max(0, attempts - 1)] ?? backoffMinutes[backoffMinutes.length - 1];
      return [r.id, { attempts, nextRetryAt: new Date(last.getTime() + wait * 60_000), awaitingAdminDecision: false }];
    }),
  );
}

/**
 * Reprocessamento automático (chamado pela reconciliação/cron). Só toca reembolsos
 * FAILED que o pedido ainda espera (`AWAITING_REFUND_WHERE`) cuja espera já passou; nunca os que aguardam o admin.
 */
export async function retryFailedRefunds(db: Db, adapter: PaymentProviderAdapter, now = new Date(), limit = 200) {
  const failed = await db.refund.findMany({
    where: AWAITING_REFUND_WHERE,
    select: { id: true, orderId: true, note: true, updatedAt: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  const states = await refundRetryStates(db, failed);
  const report = { retried: 0, succeeded: 0, awaitingAdminDecision: 0, errors: [] as { kind: string; id: string; orderId: string; message: string }[] };
  for (const r of failed) {
    const state = states.get(r.id)!;
    if (state.awaitingAdminDecision) {
      report.awaitingAdminDecision++;
      continue;
    }
    if (state.nextRetryAt! > now) continue;
    try {
      const after = await processRefund(db, adapter, r.id);
      report.retried++;
      if (after?.status === "SUCCEEDED") report.succeeded++;
      else if (after?.status === "FAILED" && (await refundRetryStates(db, [after])).get(r.id)!.awaitingAdminDecision) report.awaitingAdminDecision++;
    } catch (err) {
      report.errors.push({ kind: "refund-retry", id: r.id, orderId: r.orderId, message: String(err).slice(0, 300) });
    }
  }
  return report;
}

const RESTORABLE_REASONS: RefundReason[] = ["CUSTOMER_REQUEST", "ADMIN", "EVENT_CHANGED"];

/** Motivo pelo qual os ingressos NÃO podem ser restaurados; nulo se podem. */
export function restoreBlockedReason(reason: RefundReason, event: { status: string; endsAt: Date }, now = new Date()): string | null {
  if (!RESTORABLE_REASONS.includes(reason)) return "Este reembolso não pode ser desfeito (evento cancelado ou pagamento tardio sem estoque): só é possível reprocessar.";
  if (event.status === "CANCELLED") return "O evento foi cancelado: só é possível reprocessar o reembolso.";
  if (event.endsAt.getTime() <= now.getTime()) return "O evento já terminou: restaurar ingressos não teria efeito; reprocesse o reembolso.";
  return null;
}

export interface FailedRefundView extends RefundRetryState {
  refundId: string;
  orderId: string;
  orderPublicCode: string;
  eventId: string;
  eventTitle: string;
  reason: RefundReason;
  amountCents: number;
  partial: boolean;
  note: string | null;
  failedAt: Date;
  restoreBlockedReason: string | null;
}

/** Fila do admin: todos os reembolsos FAILED de pedidos aguardando reembolso. */
export async function listFailedRefunds(db: Db, admin: Actor, now = new Date()): Promise<FailedRefundView[]> {
  assertAdminPermission(admin, "finance:refunds");
  const refunds = await db.refund.findMany({
    where: AWAITING_REFUND_WHERE,
    include: { order: { select: { publicCode: true, event: { select: { id: true, title: true, status: true, endsAt: true } } } } },
    orderBy: { updatedAt: "asc" },
  });
  const states = await refundRetryStates(db, refunds);
  return refunds.map((r) => ({
    ...states.get(r.id)!,
    refundId: r.id,
    orderId: r.orderId,
    orderPublicCode: r.order.publicCode,
    eventId: r.order.event.id,
    eventTitle: r.order.event.title,
    reason: r.reason,
    amountCents: r.amountCents,
    partial: r.partial,
    note: r.note,
    failedAt: r.updatedAt,
    restoreBlockedReason: restoreBlockedReason(r.reason, r.order.event, now),
  }));
}

/** Decisão do admin: nova tentativa no provedor, com a mesma chave de idempotência. */
export async function adminRetryRefund(db: Db, adapter: PaymentProviderAdapter, admin: Actor, refundId: string, note: string) {
  assertAdminPermission(admin, "finance:refunds");
  if (!note.trim()) throw new AppError("VALIDATION", "Informe o motivo do reprocessamento.");
  const refund = await db.refund.findUnique({ where: { id: refundId }, include: { order: { select: { status: true, organizationId: true } } } });
  if (!refund) throw notFound("Reembolso não encontrado.");
  if (refund.status !== "FAILED") throw invalidState("Só reembolsos com falha podem ser reprocessados.");
  if (!orderAwaitsRefund(refund, refund.order.status)) throw invalidState("O pedido não está aguardando reembolso.");
  await audit(db, {
    actorUserId: admin.id,
    organizationId: refund.order.organizationId,
    action: "refund.admin_retry",
    entityType: "Refund",
    entityId: refundId,
    metadata: { orderId: refund.orderId, note },
  });
  financeLog("info", "refund.admin_retry", { orderId: refund.orderId, refundId }, { adminId: admin.id });
  await processRefund(db, adapter, refundId);
  return db.refund.findUniqueOrThrow({ where: { id: refundId } });
}

export type RestoreOutcome = "RESTORED" | "ALREADY_REFUNDED";

/**
 * Decisão do admin: desiste do reembolso FAILED, devolve os ingressos revogados
 * por ele e volta o pedido a PAID. O reembolso fica REJECTED (terminal).
 *
 * Antes de restaurar, consulta o provedor: uma falha por erro de rede pode ter
 * estornado de fato. Se o pagamento já consta estornado, o reembolso é
 * CONFIRMADO em vez de desfeito (`ALREADY_REFUNDED`).
 *
 * Contadores e razão não mudam: a solicitação só revoga ingressos; `quantityRefunded`,
 * o status do pagamento e o estorno no razão só são gravados na confirmação.
 */
export async function adminRestoreAfterFailedRefund(
  db: Db,
  adapter: PaymentProviderAdapter,
  admin: Actor,
  refundId: string,
  note: string,
  now = new Date(),
): Promise<{ outcome: RestoreOutcome; restoredTickets: number }> {
  assertAdminPermission(admin, "finance:refunds");
  if (!note.trim()) throw new AppError("VALIDATION", "Informe o motivo da restauração.");
  const refund = await db.refund.findUnique({ where: { id: refundId }, include: { payment: true, order: { include: { event: true } } } });
  if (!refund) throw notFound("Reembolso não encontrado.");
  if (refund.status !== "FAILED") throw invalidState("Só reembolsos com falha podem ser desfeitos.");
  if (!orderAwaitsRefund(refund, refund.order.status)) throw invalidState("O pedido não está aguardando reembolso.");
  const blocked = restoreBlockedReason(refund.reason, refund.order.event, now);
  if (blocked) throw invalidState(blocked);

  const p = refund.payment;
  if (p && p.status !== "PAID") throw invalidState(`Pagamento está ${p.status}: restauração exige análise manual.`);
  if (p?.providerPaymentId && p.method !== "FREE" && refund.amountCents > 0) {
    let snapshot;
    try {
      snapshot = await adapter.getPayment(p.providerPaymentId, {
        organizationId: refund.order.organizationId,
      });
    } catch (err) {
      financeLog("error", "refund.restore_provider_check_failed", { orderId: refund.orderId, refundId, paymentId: p.id }, { message: String(err).slice(0, 300) });
      throw new AppError("PROVIDER_ERROR", "Não foi possível confirmar com o provedor que o estorno não ocorreu. Tente novamente.");
    }
    // Parcial: o pagamento continua aprovado no provedor; o que mostra se este estorno
    // aconteceu é o total estornado, comparado com os reembolsos já concluídos.
    let refundedHere = snapshot.status === "REFUNDED";
    if (!refundedHere && refund.partial) {
      if (snapshot.refundedCents == null) throw new AppError("PROVIDER_ERROR", "O provedor não informou o total estornado: não é possível confirmar que este estorno não ocorreu.");
      const succeeded = await committedRefundCents(db, refund.orderId, ["SUCCEEDED"], refundId);
      if (snapshot.refundedCents >= succeeded + refund.amountCents) refundedHere = true;
      else if (snapshot.refundedCents !== succeeded) throw invalidState("O total estornado no provedor não bate com os reembolsos do pedido: restauração exige análise manual.");
    }
    if (refundedHere) {
      // O dinheiro já voltou ao comprador: confirmar, nunca devolver os ingressos.
      await db.$transaction(async (tx) => {
        await lockEvent(tx, refund.order.eventId);
        await lockOrder(tx, refund.orderId);
        const current = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: { status: true } });
        if (current.status === "FAILED") await confirmRefundTx(tx, refundId, now);
      }, TX_OPTIONS);
      await audit(db, { actorUserId: admin.id, organizationId: refund.order.organizationId, action: "refund.restore_found_refunded", entityType: "Refund", entityId: refundId, metadata: { orderId: refund.orderId, note } });
      financeLog("warn", "refund.restore_found_refunded", { orderId: refund.orderId, refundId }, { adminId: admin.id });
      return { outcome: "ALREADY_REFUNDED", restoredTickets: 0 };
    }
    if (snapshot.status !== "PAID") throw invalidState(`Pagamento no provedor está ${snapshot.status}: restauração exige análise manual.`);
  }

  const restoredTickets = await db.$transaction(async (tx) => {
    await lockEvent(tx, refund.order.eventId);
    await lockOrder(tx, refund.orderId);
    // Transição condicional: uma retentativa concorrente (FAILED → PROCESSING) ou a
    // própria restauração repetida perdem aqui e nada é alterado.
    const claimed = await tx.refund.updateMany({
      where: { id: refundId, status: "FAILED" },
      data: { status: "REJECTED", processedAt: now, note: `RESTORED_BY_ADMIN: ${note.trim().slice(0, 300)} | última falha: ${refund.note ?? "-"}`.slice(0, 1000) },
    });
    if (!claimed.count) throw invalidState("O reembolso mudou de estado; atualize a página.");
    const [order, event] = await Promise.all([
      tx.order.findUniqueOrThrow({ where: { id: refund.orderId }, select: { status: true } }),
      tx.event.findUniqueOrThrow({ where: { id: refund.order.eventId }, select: { status: true, endsAt: true } }),
    ]);
    if (!orderAwaitsRefund(refund, order.status)) throw invalidState("O pedido não está aguardando reembolso.");
    const late = restoreBlockedReason(refund.reason, event, now);
    if (late) throw invalidState(late);
    // Só os ingressos deste reembolso: os de reembolsos parciais já concluídos continuam cancelados.
    const tickets = await tx.issuedTicket.updateMany({
      where: { refundId, status: "REVOKED", revocationReason: "REFUNDED" },
      data: { status: "VALID", revokedAt: null, revocationReason: null },
    });
    await tx.issuedTicket.updateMany({ where: { refundId }, data: { refundId: null } });
    if (order.status !== "PAID") await tx.order.update({ where: { id: refund.orderId }, data: { status: "PAID" } });
    await audit(tx, {
      actorUserId: admin.id,
      organizationId: refund.order.organizationId,
      action: "refund.rejected_tickets_restored",
      entityType: "Refund",
      entityId: refundId,
      metadata: { orderId: refund.orderId, note, restoredTickets: tickets.count },
    });
    await enqueueRefundRestoredEmailTx(tx, refundId);
    return tickets.count;
  }, TX_OPTIONS);
  financeLog("info", "refund.tickets_restored", { orderId: refund.orderId, refundId }, { adminId: admin.id, restoredTickets });
  return { outcome: "RESTORED", restoredTickets };
}

/**
 * Retoma um reembolso parado em PROCESSING (ex.: o processo caiu entre "reivindicar"
 * e chamar o provedor). Reenvia ao provedor com a MESMA chave de idempotência, então
 * nunca estorna duas vezes. Usado pela reconciliação.
 */
export async function resumeRefund(db: Db, adapter: PaymentProviderAdapter, refundId: string) {
  const refund = await db.refund.findUnique({
    where: { id: refundId },
    include: { payment: true, order: { select: { organizationId: true } } },
  });
  if (!refund) return null;
  if (refund.status === "REQUESTED") return (await processRefund(db, adapter, refundId))?.status ?? null;
  if (refund.status !== "PROCESSING") return refund.status;
  if (refund.amountCents === 0 || !refund.payment?.providerPaymentId || refund.payment.method === "FREE") {
    await db.$transaction((tx) => confirmRefundTxWithLocks(tx, refundId), TX_OPTIONS);
    return "SUCCEEDED";
  }
  let result;
  try {
    result = await adapter.refundPayment({
      providerPaymentId: refund.payment.providerPaymentId,
      amountCents: refund.amountCents,
      idempotencyKey: refund.idempotencyKey,
      organizationId: refund.order.organizationId,
    });
  } catch (err) {
    // Entra na política de retentativas limitadas em vez de ficar preso em PROCESSING.
    await recordRefundFailure(db, refund, "PROVIDER_ERROR", `Erro no provedor (reconciliação): ${String(err).slice(0, 300)}`);
    return "FAILED";
  }
  await db.refund.update({ where: { id: refundId }, data: { providerRefundId: result.providerRefundId } });
  if (result.status === "SUCCEEDED") await db.$transaction((tx) => confirmRefundTxWithLocks(tx, refundId), TX_OPTIONS);
  else if (result.status === "FAILED") await recordRefundFailure(db, refund, "PROVIDER_REFUSED", "Provedor recusou o estorno (reconciliação).");
  return result.status;
}

async function confirmRefundTxWithLocks(tx: Tx, refundId: string) {
  const r = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: { order: { select: { id: true, eventId: true } } } });
  await lockEvent(tx, r.order.eventId);
  await lockOrder(tx, r.order.id);
  await confirmRefundTx(tx, refundId);
}

/**
 * Efetiva o reembolso: revoga os ingressos que ele cobre, atualiza contadores e
 * lança o estorno no razão. Integral: cobre também os ingressos do pedido ainda sem
 * reembolso (cancelamento do evento, estorno iniciado no provedor) e fecha o pedido
 * como REFUNDED; o valor é o total menos os parciais. Parcial: só os seus ingressos;
 * o pedido fecha como REFUNDED quando o último ingresso é reembolsado.
 * Pré-condição: travas do evento e do pedido. Idempotente.
 */
export async function confirmRefundTx(tx: Tx, refundId: string, now = new Date()) {
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (refund.status === "SUCCEEDED") return false;
  const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId }, include: { commissionRule: true } });
  // Última linha de defesa: nunca registrar estorno acima do valor pago.
  if ((await committedRefundCents(tx, order.id, ["SUCCEEDED"], refundId)) + refund.amountCents > order.totalCents) {
    throw new OverRefundError(`Reembolso ${refundId} excederia o valor pago do pedido ${order.publicCode}.`);
  }

  await tx.refund.update({ where: { id: refundId }, data: { status: "SUCCEEDED", processedAt: now } });
  const reason = refund.reason === "EVENT_CANCELLED" ? "EVENT_CANCELLED" : "REFUNDED";
  if (!refund.partial) await tx.issuedTicket.updateMany({ where: { orderId: order.id, refundId: null }, data: { refundId } });
  const covered = await tx.issuedTicket.findMany({ where: { refundId }, select: { id: true, ticketTypeId: true } });
  const coveredIds = covered.map((t) => t.id);
  await tx.issuedTicket.updateMany({ where: { id: { in: coveredIds }, status: { in: ["VALID", "CHECKED_IN"] } }, data: { status: "REVOKED", revokedAt: now, revocationReason: reason } });
  await closePendingTransfersTx(tx, { ticketIds: coveredIds }, reason === "EVENT_CANCELLED" ? "Evento cancelado" : "Ingresso reembolsado", now);
  const perType = new Map<string, number>();
  for (const t of covered) perType.set(t.ticketTypeId, (perType.get(t.ticketTypeId) ?? 0) + 1);
  for (const [ticketTypeId, n] of perType) {
    await tx.ticketType.update({ where: { id: ticketTypeId }, data: { quantityRefunded: { increment: n } } });
  }

  // Valores do estorno no razão.
  let amounts: { totalCents: number; commissionCents: number; serviceFeeCents: number };
  if (refund.partial) {
    amounts = await ticketRefundAmounts(tx, { refundId });
  } else {
    const parts = await ticketRefundAmounts(tx, { orderId: order.id, refund: { partial: true, status: { not: "REJECTED" }, NOT: { id: refundId } } });
    amounts = { totalCents: order.totalCents - parts.totalCents, commissionCents: order.commissionCents - parts.commissionCents, serviceFeeCents: order.serviceFeeCents - parts.serviceFeeCents };
  }
  if (amounts.totalCents !== refund.amountCents) {
    throw new OverRefundError(`Reembolso ${refundId}: valor ${refund.amountCents} difere dos ingressos cobertos (${amounts.totalCents}).`);
  }

  // Pedido encerrado quando nenhum ingresso fica fora de um reembolso concluído.
  const remaining = refund.partial
    ? await tx.issuedTicket.count({ where: { orderId: order.id, OR: [{ refundId: null }, { refund: { status: { not: "SUCCEEDED" } } }] } })
    : 0;
  if (!remaining) {
    if (refund.paymentId) await tx.payment.update({ where: { id: refund.paymentId }, data: { status: "REFUNDED" } });
    await tx.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
  }
  await postReversal(tx, "REFUND", { ...order, ...amounts }, {
    refundId,
    paymentId: refund.paymentId ?? undefined,
    returnCommission: order.commissionRule?.refundCommissionOnRefund ?? true,
  });
  await audit(tx, {
    organizationId: order.organizationId,
    action: "refund.succeeded",
    entityType: "Refund",
    entityId: refundId,
    metadata: { reason: refund.reason, ...(refund.partial ? { partial: true, tickets: coveredIds.length } : {}) },
  });
  await enqueueRefundEmailTx(tx, refundId);
  return true;
}
