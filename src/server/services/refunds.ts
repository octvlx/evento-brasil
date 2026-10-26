// Reembolsos integrais (MVP). Reembolso parcial não é suportado.
import "server-only";
import type { RefundReason, RefundStatus } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { assertActive, assertPlatformAdmin, type Actor } from "../auth/permissions";
import { env } from "../env";
import { AppError, forbidden, invalidState, notFound } from "../errors";
import type { PaymentProviderAdapter } from "../payments/types";
import { financeLog } from "./finance-log";
import { postReversal } from "./ledger";
import { lockEvent, lockOrder } from "./orders";

export interface RefundPolicyConfig {
  windowDays: number;
  minHoursBeforeEvent: number;
}

export const refundPolicyFromEnv = (): RefundPolicyConfig => ({
  windowDays: env().REFUND_WINDOW_DAYS,
  minHoursBeforeEvent: env().REFUND_MIN_HOURS_BEFORE_EVENT,
});

/**
 * Elegibilidade para reembolso solicitado pelo comprador. Valores padrão
 * (7 dias da compra e 48h antes do evento) são configuráveis e PRECISAM de
 * revisão jurídica (CDC art. 49 e normas aplicáveis a eventos).
 */
export function refundEligibility(
  order: { status: string; paidAt: Date | null; totalCents: number },
  event: { startsAt: Date; status: string },
  tickets: { status: string }[],
  now: Date,
  cfg: RefundPolicyConfig,
): { eligible: true } | { eligible: false; reason: string } {
  if (order.status !== "PAID") return { eligible: false, reason: "Somente pedidos pagos podem ser reembolsados." };
  if (event.status === "CANCELLED") return { eligible: false, reason: "Evento cancelado: o reembolso é processado automaticamente." };
  if (tickets.some((t) => t.status === "CHECKED_IN")) return { eligible: false, reason: "Há ingressos já utilizados neste pedido." };
  if (!order.paidAt || now.getTime() - order.paidAt.getTime() > cfg.windowDays * 86_400_000)
    return { eligible: false, reason: `O prazo de ${cfg.windowDays} dias após a compra terminou.` };
  if (event.startsAt.getTime() - now.getTime() < cfg.minHoursBeforeEvent * 3_600_000)
    return { eligible: false, reason: `Reembolsos só até ${cfg.minHoursBeforeEvent}h antes do evento.` };
  return { eligible: true };
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

async function createRefundRequest(db: Db, orderId: string, reason: RefundReason, requestedById: string | null, note?: string) {
  return db.$transaction(async (tx) => {
    const ref = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { eventId: true } });
    await lockEvent(tx, ref.eventId);
    await lockOrder(tx, orderId);
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: { where: { status: "PAID" } } } });
    if (order.status !== "PAID") throw invalidState("Pedido não está pago.");
    // Reembolsos são integrais (MVP): qualquer outro em aberto ou concluído impede um novo.
    if ((await committedRefundCents(tx, orderId, ["REQUESTED", "PROCESSING", "SUCCEEDED"])) > 0) {
      throw invalidState("Este pedido já tem um reembolso em andamento.");
    }
    // Revoga os ingressos AGORA, sob as travas: um check-in concorrente
    // (UPDATE … WHERE status='VALID') não consegue mais usar o ingresso, e um
    // check-in que chegou antes é detectado abaixo. Antes, a verificação era
    // feita fora da trava e o comprador podia entrar E ser reembolsado.
    const now = new Date();
    await tx.issuedTicket.updateMany({ where: { orderId, status: "VALID" }, data: { status: "REVOKED", revokedAt: now, revocationReason: "REFUNDED" } });
    if (reason === "CUSTOMER_REQUEST") {
      const used = await tx.issuedTicket.count({ where: { orderId, status: "CHECKED_IN" } });
      if (used > 0) throw new AppError("VALIDATION", "Há ingressos já utilizados neste pedido.");
    }
    // Um reembolso anterior com o mesmo motivo pode ter sido encerrado como
    // REJECTED (admin restaurou os ingressos): o novo pedido precisa de chave própria.
    const rejected = await tx.refund.count({ where: { orderId, reason, status: "REJECTED" } });
    const key = `refund:${orderId}:${reason.toLowerCase()}${rejected ? `:${rejected + 1}` : ""}`;
    const refund = await tx.refund.upsert({
      where: { idempotencyKey: key },
      create: { orderId, paymentId: order.payments[0]?.id ?? null, amountCents: order.totalCents, reason, requestedById, note, idempotencyKey: key },
      update: {},
    });
    await tx.order.update({ where: { id: orderId }, data: { status: "REFUND_PENDING" } });
    await audit(tx, { actorUserId: requestedById, organizationId: order.organizationId, action: "refund.requested", entityType: "Refund", entityId: refund.id, metadata: { reason } });
    return refund;
  }, TX_OPTIONS);
}

export async function requestCustomerRefund(db: Db, adapter: PaymentProviderAdapter, actor: Actor, orderId: string, now = new Date()) {
  assertActive(actor);
  const order = await db.order.findUnique({ where: { id: orderId }, include: { event: true, tickets: { select: { status: true } } } });
  if (!order) throw notFound();
  if (order.userId !== actor.id) throw forbidden();
  const check = refundEligibility(order, order.event, order.tickets, now, refundPolicyFromEnv());
  if (!check.eligible) throw new AppError("VALIDATION", check.reason);
  const refund = await createRefundRequest(db, orderId, "CUSTOMER_REQUEST", actor.id);
  await processRefund(db, adapter, refund.id);
  return db.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

export async function adminRefundOrder(db: Db, adapter: PaymentProviderAdapter, admin: Actor, orderId: string, note: string) {
  assertPlatformAdmin(admin);
  if (!note.trim()) throw new AppError("VALIDATION", "Informe o motivo do reembolso.");
  const refund = await createRefundRequest(db, orderId, "ADMIN", admin.id, note);
  await processRefund(db, adapter, refund.id);
  return db.refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** Solicita o estorno ao provedor. Confirma imediatamente se o provedor responder sucesso. */
export async function processRefund(db: Db, adapter: PaymentProviderAdapter, refundId: string) {
  const refund = await db.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
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
  const { attempt, awaitingDecision } = await db.$transaction(async (tx) => {
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
    return { attempt, awaitingDecision };
  }, TX_OPTIONS);
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
 * FAILED de pedidos em REFUND_PENDING cuja espera já passou; nunca os que aguardam o admin.
 */
export async function retryFailedRefunds(db: Db, adapter: PaymentProviderAdapter, now = new Date(), limit = 200) {
  const failed = await db.refund.findMany({
    where: { status: "FAILED", order: { status: "REFUND_PENDING" } },
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

const RESTORABLE_REASONS: RefundReason[] = ["CUSTOMER_REQUEST", "ADMIN"];

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
  note: string | null;
  failedAt: Date;
  restoreBlockedReason: string | null;
}

/** Fila do admin: todos os reembolsos FAILED de pedidos aguardando reembolso. */
export async function listFailedRefunds(db: Db, admin: Actor, now = new Date()): Promise<FailedRefundView[]> {
  assertPlatformAdmin(admin);
  const refunds = await db.refund.findMany({
    where: { status: "FAILED", order: { status: "REFUND_PENDING" } },
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
    note: r.note,
    failedAt: r.updatedAt,
    restoreBlockedReason: restoreBlockedReason(r.reason, r.order.event, now),
  }));
}

/** Decisão do admin: nova tentativa no provedor, com a mesma chave de idempotência. */
export async function adminRetryRefund(db: Db, adapter: PaymentProviderAdapter, admin: Actor, refundId: string, note: string) {
  assertPlatformAdmin(admin);
  if (!note.trim()) throw new AppError("VALIDATION", "Informe o motivo do reprocessamento.");
  const refund = await db.refund.findUnique({ where: { id: refundId }, include: { order: { select: { status: true, organizationId: true } } } });
  if (!refund) throw notFound("Reembolso não encontrado.");
  if (refund.status !== "FAILED") throw invalidState("Só reembolsos com falha podem ser reprocessados.");
  if (refund.order.status !== "REFUND_PENDING") throw invalidState("O pedido não está aguardando reembolso.");
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
  assertPlatformAdmin(admin);
  if (!note.trim()) throw new AppError("VALIDATION", "Informe o motivo da restauração.");
  const refund = await db.refund.findUnique({ where: { id: refundId }, include: { payment: true, order: { include: { event: true } } } });
  if (!refund) throw notFound("Reembolso não encontrado.");
  if (refund.status !== "FAILED") throw invalidState("Só reembolsos com falha podem ser desfeitos.");
  if (refund.order.status !== "REFUND_PENDING") throw invalidState("O pedido não está aguardando reembolso.");
  const blocked = restoreBlockedReason(refund.reason, refund.order.event, now);
  if (blocked) throw invalidState(blocked);

  const p = refund.payment;
  if (p && p.status !== "PAID") throw invalidState(`Pagamento está ${p.status}: restauração exige análise manual.`);
  if (p?.providerPaymentId && p.method !== "FREE" && refund.amountCents > 0) {
    let snapshot;
    try {
      snapshot = await adapter.getPayment(p.providerPaymentId);
    } catch (err) {
      financeLog("error", "refund.restore_provider_check_failed", { orderId: refund.orderId, refundId, paymentId: p.id }, { message: String(err).slice(0, 300) });
      throw new AppError("PROVIDER_ERROR", "Não foi possível confirmar com o provedor que o estorno não ocorreu. Tente novamente.");
    }
    if (snapshot.status === "REFUNDED") {
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
    if (order.status !== "REFUND_PENDING") throw invalidState("O pedido não está aguardando reembolso.");
    const late = restoreBlockedReason(refund.reason, event, now);
    if (late) throw invalidState(late);
    const tickets = await tx.issuedTicket.updateMany({
      where: { orderId: refund.orderId, status: "REVOKED", revocationReason: "REFUNDED" },
      data: { status: "VALID", revokedAt: null, revocationReason: null },
    });
    await tx.order.update({ where: { id: refund.orderId }, data: { status: "PAID" } });
    await audit(tx, {
      actorUserId: admin.id,
      organizationId: refund.order.organizationId,
      action: "refund.rejected_tickets_restored",
      entityType: "Refund",
      entityId: refundId,
      metadata: { orderId: refund.orderId, note, restoredTickets: tickets.count },
    });
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
  const refund = await db.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
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
 * Efetiva o reembolso: revoga ingressos, atualiza contadores e lança o estorno
 * no razão. Pré-condição: travas do evento e do pedido. Idempotente.
 */
export async function confirmRefundTx(tx: Tx, refundId: string, now = new Date()) {
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (refund.status === "SUCCEEDED") return false;
  const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId }, include: { commissionRule: true, tickets: true } });
  // Última linha de defesa: nunca registrar estorno acima do valor pago.
  if ((await committedRefundCents(tx, order.id, ["SUCCEEDED"], refundId)) + refund.amountCents > order.totalCents) {
    throw new OverRefundError(`Reembolso ${refundId} excederia o valor pago do pedido ${order.publicCode}.`);
  }

  await tx.refund.update({ where: { id: refundId }, data: { status: "SUCCEEDED", processedAt: now } });
  const reason = refund.reason === "EVENT_CANCELLED" ? "EVENT_CANCELLED" : "REFUNDED";
  await tx.issuedTicket.updateMany({ where: { orderId: order.id, status: { in: ["VALID", "CHECKED_IN"] } }, data: { status: "REVOKED", revokedAt: now, revocationReason: reason } });
  const perType = new Map<string, number>();
  for (const t of order.tickets) perType.set(t.ticketTypeId, (perType.get(t.ticketTypeId) ?? 0) + 1);
  for (const [ticketTypeId, n] of perType) {
    await tx.ticketType.update({ where: { id: ticketTypeId }, data: { quantityRefunded: { increment: n } } });
  }
  if (refund.paymentId) await tx.payment.update({ where: { id: refund.paymentId }, data: { status: "REFUNDED" } });
  await tx.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
  await postReversal(tx, "REFUND", order, {
    refundId,
    paymentId: refund.paymentId ?? undefined,
    returnCommission: order.commissionRule?.refundCommissionOnRefund ?? true,
  });
  await audit(tx, { organizationId: order.organizationId, action: "refund.succeeded", entityType: "Refund", entityId: refundId, metadata: { reason: refund.reason } });
  return true;
}
