// Leituras das filas do admin (Fase 4): pedidos de cancelamento, transferências,
// janelas de reembolso por alteração e auditoria. Somente leitura: as decisões
// passam pelos serviços de domínio (cancellation-requests, refunds), que
// continuam sendo a fonte da verdade.
import "server-only";
import type { CancellationRequestStatus, OrderStatus, Prisma, TicketTransferStatus } from "@/generated/prisma/client";
import type { Db } from "../db";
import { assertPlatformAdmin, type Actor, assertAdminPermission } from "../auth/permissions";
import { notFound } from "../errors";
import { checkFinancialInvariants } from "./reconciliation";
import { AWAITING_REFUND_WHERE, openChangeRefundWindow, refundEligibility } from "./refunds";
import { audit } from "../audit";
import { formatDateTimeShort } from "@/lib/datetime";
import { parseSalesPeriod, type SalesPeriod } from "@/features/reports/period";
import { toCsv } from "./reports";

export const ADMIN_PAGE_SIZE = 25;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageCount: number;
}

/** Página 1-based a partir de um parâmetro de URL qualquer. */
export function parsePage(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

function paging(page: number, total: number) {
  const pageCount = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pageCount);
  return { page: current, pageCount, skip: (current - 1) * ADMIN_PAGE_SIZE, take: ADMIN_PAGE_SIZE };
}

// ───────────────────────────── Pedidos de cancelamento ─────────────────────────────

const CANCELLATION_STATUSES: readonly CancellationRequestStatus[] = ["OPEN", "APPROVED", "REJECTED", "WITHDRAWN"];

export function parseCancellationStatus(raw: unknown): CancellationRequestStatus {
  return CANCELLATION_STATUSES.find((s) => s === raw) ?? "OPEN";
}

/**
 * Fila paginada. Abertos: prazo mais curto primeiro (os vencidos no topo);
 * decididos: mais recentes primeiro. `overdueOnly` restringe aos abertos com prazo vencido.
 */
export async function listCancellationQueue(
  db: Db,
  admin: Actor,
  opts: { status?: CancellationRequestStatus; overdueOnly?: boolean; page?: number } = {},
  now = new Date(),
) {
  assertAdminPermission(admin, "cancellations:decide");
  const status = opts.overdueOnly ? "OPEN" : (opts.status ?? "OPEN");
  const where: Prisma.CancellationRequestWhereInput = { status, ...(opts.overdueOnly ? { respondBy: { lt: now } } : {}) };
  const [total, overdueCount] = await Promise.all([
    db.cancellationRequest.count({ where }),
    db.cancellationRequest.count({ where: { status: "OPEN", respondBy: { lt: now } } }),
  ]);
  const p = paging(opts.page ?? 1, total);
  const rows = await db.cancellationRequest.findMany({
    where,
    include: {
      order: { select: { publicCode: true, status: true, totalCents: true } },
      event: { select: { title: true, startsAt: true } },
      requestedBy: { select: { email: true } },
      refunds: { select: { status: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: status === "OPEN" ? [{ respondBy: "asc" }, { createdAt: "asc" }, { id: "asc" }] : [{ decidedAt: "desc" }, { id: "asc" }],
    skip: p.skip,
    take: p.take,
  });
  const items = rows.map((r) => ({ ...r, overdue: r.status === "OPEN" && !!r.respondBy && r.respondBy < now }));
  return { items, total, page: p.page, pageCount: p.pageCount, overdueCount, status, overdueOnly: !!opts.overdueOnly };
}

/** Contadores para a visão geral do admin. */
export async function adminQueueCounts(db: Db, admin: Actor, now = new Date()) {
  assertPlatformAdmin(admin);
  const [openCancellations, overdueCancellations, failedRefunds] = await Promise.all([
    db.cancellationRequest.count({ where: { status: "OPEN" } }),
    db.cancellationRequest.count({ where: { status: "OPEN", respondBy: { lt: now } } }),
    db.refund.count({ where: AWAITING_REFUND_WHERE }),
  ]);
  return { openCancellations, overdueCancellations, failedRefunds };
}

/** Detalhe para decidir: pedido, pagamentos, reembolsos e a elegibilidade de hoje pela política. */
export async function getCancellationRequestDetail(db: Db, admin: Actor, requestId: string, now = new Date()) {
  assertAdminPermission(admin, "cancellations:decide");
  const request = await db.cancellationRequest.findUnique({
    where: { id: requestId },
    include: {
      order: {
        select: {
          id: true,
          publicCode: true,
          status: true,
          buyerName: true,
          buyerEmail: true,
          subtotalCents: true,
          serviceFeeCents: true,
          discountCents: true,
          totalCents: true,
          paidAt: true,
          createdAt: true,
          isSimulated: true,
          payments: { select: { id: true, method: true, status: true, amountCents: true, provider: true, failureReason: true, createdAt: true }, orderBy: { createdAt: "desc" } },
          refunds: { select: { id: true, status: true, reason: true, amountCents: true, note: true, createdAt: true, cancellationRequestId: true }, orderBy: { createdAt: "desc" } },
          tickets: { select: { status: true } },
        },
      },
      event: { select: { id: true, title: true, startsAt: true, status: true, timezone: true, refundWindowDays: true, refundMinHoursBeforeEvent: true } },
      organization: { select: { name: true } },
      requestedBy: { select: { name: true, email: true } },
      decidedBy: { select: { email: true } },
    },
  });
  if (!request) throw notFound("Pedido de cancelamento não encontrado.");
  const window = await openChangeRefundWindow(db, request.eventId, request.order.paidAt, now);
  const eligibilityNow = refundEligibility(request.order, request.event, request.order.tickets, now, window);
  const ticketCounts = request.order.tickets.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {});
  return { request, eligibilityNow, ticketCounts, overdue: request.status === "OPEN" && !!request.respondBy && request.respondBy < now };
}

// ───────────────────────────── Transferências ─────────────────────────────

const TRANSFER_STATUSES: readonly TicketTransferStatus[] = ["PENDING", "ACCEPTED", "CANCELLED", "EXPIRED"];

export function parseTransferStatus(raw: unknown): TicketTransferStatus | undefined {
  return TRANSFER_STATUSES.find((s) => s === raw);
}

/** Histórico de transferências (somente leitura), por código do ingresso, e-mail ou evento. */
export async function searchTransfers(db: Db, admin: Actor, opts: { q?: string; status?: TicketTransferStatus; page?: number } = {}) {
  assertAdminPermission(admin, "transfers:read");
  const q = opts.q?.trim().slice(0, 200) ?? "";
  const where: Prisma.TicketTransferWhereInput = {
    ...(opts.status ? { status: opts.status } : {}),
    ...(q
      ? {
          OR: [
            { ticket: { code: q.toUpperCase() } },
            { fromHolderEmail: { contains: q, mode: "insensitive" } },
            { toEmail: { contains: q.toLowerCase() } },
            { event: { title: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const total = await db.ticketTransfer.count({ where });
  const p = paging(opts.page ?? 1, total);
  // Nunca seleciona tokenHash/previousTokenHash.
  const items = await db.ticketTransfer.findMany({
    where,
    select: {
      id: true,
      status: true,
      initiatedBy: true,
      fromHolderName: true,
      fromHolderEmail: true,
      toEmail: true,
      toHolderName: true,
      reason: true,
      decisionReason: true,
      createdAt: true,
      expiresAt: true,
      decidedAt: true,
      ticket: { select: { code: true } },
      event: { select: { title: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: p.skip,
    take: p.take,
  });
  return { items, total, page: p.page, pageCount: p.pageCount, q };
}

/** Limiares do relatório de padrões suspeitos (apenas sinalização; nenhuma ação automática). */
export const TRANSFER_PATTERN_DEFAULTS = { windowHours: 24, minCount: 3 } as const;

/**
 * Padrões a revisar na janela: muitos envios pelo mesmo titular, muitos
 * recebimentos pelo mesmo e-mail e o mesmo ingresso passando por várias mãos.
 */
export async function transferPatternReport(
  db: Db,
  admin: Actor,
  opts: { windowHours?: number; minCount?: number } = {},
  now = new Date(),
) {
  assertAdminPermission(admin, "transfers:read");
  const windowHours = opts.windowHours ?? TRANSFER_PATTERN_DEFAULTS.windowHours;
  const minCount = opts.minCount ?? TRANSFER_PATTERN_DEFAULTS.minCount;
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  const base: Prisma.TicketTransferWhereInput = { createdAt: { gte: since }, initiatedBy: "HOLDER" };
  const having = { id: { _count: { gte: minCount } } };
  const [senders, recipients, tickets] = await Promise.all([
    db.ticketTransfer.groupBy({ by: ["fromUserId", "fromHolderEmail"], where: base, having, _count: { id: true }, _max: { createdAt: true } }),
    db.ticketTransfer.groupBy({ by: ["toEmail"], where: base, having, _count: { id: true }, _max: { createdAt: true } }),
    db.ticketTransfer.groupBy({ by: ["ticketId"], where: base, having, _count: { id: true }, _max: { createdAt: true } }),
  ]);
  const codes = tickets.length
    ? new Map((await db.issuedTicket.findMany({ where: { id: { in: tickets.map((t) => t.ticketId) } }, select: { id: true, code: true } })).map((t) => [t.id, t.code]))
    : new Map<string, string>();
  const byCount = <T extends { _count: { id: number } }>(a: T, b: T) => b._count.id - a._count.id;
  return {
    windowHours,
    minCount,
    since,
    senders: senders.sort(byCount).map((s) => ({ key: s.fromHolderEmail, count: s._count.id, lastAt: s._max.createdAt })),
    recipients: recipients.sort(byCount).map((r) => ({ key: r.toEmail, count: r._count.id, lastAt: r._max.createdAt })),
    tickets: tickets.sort(byCount).map((t) => ({ key: codes.get(t.ticketId) ?? t.ticketId, count: t._count.id, lastAt: t._max.createdAt })),
  };
}

// ───────────────────────────── Alterações de evento ─────────────────────────────

/**
 * Janelas de reembolso por alteração relevante ainda abertas, em todos os eventos.
 * Uma linha por alteração original; o prazo vigente considera as prorrogações.
 * Contagens: reembolsos abertos por meio dela (por status) e pedidos ainda pagos
 * antes da alteração (potencialmente elegíveis).
 */
export async function listOpenChangeWindows(db: Db, admin: Actor, opts: { page?: number } = {}, now = new Date()) {
  assertAdminPermission(admin, "events:moderate");
  const where: Prisma.EventChangeWhereInput = {
    relevant: true,
    extendsChangeId: null,
    OR: [{ refundUntil: { gt: now } }, { extensions: { some: { refundUntil: { gt: now } } } }],
  };
  const total = await db.eventChange.count({ where });
  const p = paging(opts.page ?? 1, total);
  const rows = await db.eventChange.findMany({
    where,
    select: {
      id: true,
      eventId: true,
      changedFields: true,
      reason: true,
      refundUntil: true,
      createdAt: true,
      event: { select: { title: true, startsAt: true, status: true, timezone: true } },
      organization: { select: { name: true } },
      extensions: { select: { refundUntil: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: p.skip,
    take: p.take,
  });
  const ids = rows.map((r) => r.id);
  const refundRows = ids.length
    ? await db.refund.groupBy({ by: ["eventChangeId", "status"], where: { eventChangeId: { in: ids } }, _count: { id: true }, _sum: { amountCents: true } })
    : [];
  const stillPaid = await Promise.all(rows.map((r) => db.order.count({ where: { eventId: r.eventId, status: "PAID", paidAt: { lt: r.createdAt } } })));
  const items = rows.map((r, i) => {
    const until = [r.refundUntil, ...r.extensions.map((e) => e.refundUntil)].filter((d): d is Date => !!d).reduce((a, b) => (b > a ? b : a));
    const refunds = refundRows.filter((g) => g.eventChangeId === r.id);
    return {
      ...r,
      effectiveRefundUntil: until,
      extended: r.extensions.length > 0,
      refundsByStatus: Object.fromEntries(refunds.map((g) => [g.status, g._count.id])) as Record<string, number>,
      refundsTotal: refunds.reduce((s, g) => s + g._count.id, 0),
      refundedCents: refunds.filter((g) => g.status === "SUCCEEDED").reduce((s, g) => s + (g._sum.amountCents ?? 0), 0),
      paidOrdersStillEligible: stillPaid[i],
    };
  });
  return { items, total, page: p.page, pageCount: p.pageCount };
}

// ───────────────────────────── Auditoria ─────────────────────────────

/** Filtros prontos para as ações da Fase 3/4 (os nomes são os gravados pelos serviços). */
export const AUDIT_PRESETS = {
  transfer: { label: "Transferências", prefixes: ["ticket.transfer."] },
  cancellation: { label: "Pedidos de cancelamento", prefixes: ["cancellation."] },
  event_change: { label: "Alterações de evento", prefixes: ["event.relevant_change", "event.change_"] },
  terms: { label: "Termos", prefixes: ["terms."] },
  refund: { label: "Reembolsos", prefixes: ["refund."] },
} as const satisfies Record<string, { label: string; prefixes: readonly string[] }>;

export type AuditPreset = keyof typeof AUDIT_PRESETS;

export function parseAuditPreset(raw: unknown): AuditPreset | undefined {
  return typeof raw === "string" && Object.hasOwn(AUDIT_PRESETS, raw) ? (raw as AuditPreset) : undefined;
}

/** Ator "sistema": registros sem pessoa (cron, webhooks). */
export const AUDIT_SYSTEM_ACTOR = "sistema";

/**
 * Filtros da auditoria, os mesmos na tela e no CSV. Período em dias de São Paulo
 * (fim inclusivo); ator por trecho do e-mail ou "sistema"; entidade por tipo exato e
 * ID completo ou final (a tela mostra os 8 últimos caracteres).
 */
export interface AuditFilters {
  preset?: AuditPreset;
  action?: string;
  actor?: string;
  entityType?: string;
  entityId?: string;
  period?: SalesPeriod;
}

/** Lê os filtros da URL (`grupo`, `acao`, `ator`, `entidade`, `id`, `de`, `ate`). */
export function parseAuditFilters(sp: Record<string, string | null | undefined>): AuditFilters {
  const text = (k: string, max = 100) => sp[k]?.trim().slice(0, max) || undefined;
  const period = parseSalesPeriod({ de: sp.de, ate: sp.ate });
  return {
    preset: parseAuditPreset(sp.grupo),
    action: text("acao"),
    actor: text("ator", 254),
    entityType: text("entidade", 60),
    entityId: text("id", 60),
    period: period.from || period.to ? period : undefined,
  };
}

/** Parâmetros de URL dos filtros (para links, paginação e o CSV). */
export function auditFilterParams(f: AuditFilters): Record<string, string | undefined> {
  return { grupo: f.preset, acao: f.action, ator: f.actor, entidade: f.entityType, id: f.entityId, de: f.period?.de || undefined, ate: f.period?.ate || undefined };
}

function auditWhere(f: AuditFilters): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (f.preset) and.push({ OR: AUDIT_PRESETS[f.preset].prefixes.map((p) => ({ action: { startsWith: p } })) });
  if (f.action) and.push({ action: { startsWith: f.action } });
  if (f.actor) {
    and.push(
      f.actor.toLowerCase() === AUDIT_SYSTEM_ACTOR ? { actorUserId: null } : { actor: { email: { contains: f.actor, mode: "insensitive" } } },
    );
  }
  if (f.entityType) and.push({ entityType: f.entityType });
  if (f.entityId) and.push({ entityId: { endsWith: f.entityId } });
  if (f.period?.from) and.push({ createdAt: { gte: f.period.from } });
  if (f.period?.to) and.push({ createdAt: { lt: f.period.to } });
  return and.length ? { AND: and } : {};
}

const AUDIT_INCLUDE = { actor: { select: { email: true } }, organization: { select: { name: true } } } as const;
const AUDIT_ORDER: Prisma.AuditLogOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];

export async function listAuditLogs(db: Db, admin: Actor, opts: AuditFilters & { page?: number } = {}) {
  assertAdminPermission(admin, "audit:read");
  const where = auditWhere(opts);
  const total = await db.auditLog.count({ where });
  const p = paging(opts.page ?? 1, total);
  const items = await db.auditLog.findMany({ where, include: AUDIT_INCLUDE, orderBy: AUDIT_ORDER, skip: p.skip, take: p.take });
  return { items, total, page: p.page, pageCount: p.pageCount };
}

/** Tipos de entidade já auditados (lista do filtro). */
export async function auditEntityTypes(db: Db, admin: Actor): Promise<string[]> {
  assertAdminPermission(admin, "audit:read");
  const rows = await db.auditLog.groupBy({ by: ["entityType"], orderBy: { entityType: "asc" } });
  return rows.map((r) => r.entityType);
}

/** Linhas por exportação: acima disso o CSV sai cortado e avisa para estreitar os filtros. */
export const AUDIT_EXPORT_LIMIT = 10_000;

/**
 * Exportação da auditoria com os filtros da tela. Exige a mesma permissão da leitura
 * e fica registrada (`audit.exported`, com filtros e linhas) na mesma transação da
 * leitura: não há exportação sem registro.
 */
export async function exportAuditLogs(db: Db, admin: Actor, filters: AuditFilters) {
  assertAdminPermission(admin, "audit:read");
  const where = auditWhere(filters);
  return db.$transaction(async (tx) => {
    const rows = await tx.auditLog.findMany({ where, include: AUDIT_INCLUDE, orderBy: AUDIT_ORDER, take: AUDIT_EXPORT_LIMIT + 1 });
    const truncated = rows.length > AUDIT_EXPORT_LIMIT;
    const items = truncated ? rows.slice(0, AUDIT_EXPORT_LIMIT) : rows;
    const params = Object.fromEntries(Object.entries(auditFilterParams(filters)).filter(([, v]) => v));
    await audit(tx, {
      actorUserId: admin.id,
      action: "audit.exported",
      entityType: "AuditLog",
      entityId: "export",
      metadata: { filters: params, rows: items.length, truncated },
    });
    return { items, truncated };
  });
}

/** CSV da auditoria: horário de São Paulo, ID completo da entidade e detalhes em JSON. */
export function auditLogsToCsv(items: Awaited<ReturnType<typeof exportAuditLogs>>["items"], truncated: boolean): string {
  const rows: unknown[][] = [["Quando (São Paulo)", "Ação", "Ator", "ID do ator", "Organização", "Entidade", "ID da entidade", "Detalhes"]];
  for (const l of items) {
    rows.push([
      formatDateTimeShort(l.createdAt),
      l.action,
      l.actorUserId ? (l.actor?.email ?? "") : AUDIT_SYSTEM_ACTOR,
      l.actorUserId ?? "",
      l.organization?.name ?? "",
      l.entityType,
      l.entityId,
      l.metadata == null ? "" : JSON.stringify(l.metadata),
    ]);
  }
  if (truncated) rows.push([`Exportação limitada a ${AUDIT_EXPORT_LIMIT} registros; estreite os filtros para ver o restante.`]);
  return toCsv(rows);
}

// ───────────────────────────── Pedidos e pagamentos ─────────────────────────────

/**
 * Pagamentos que exigem alguém olhar: nenhum se resolve sozinho. Valor divergente e
 * duplicidade esperam reembolso manual enquanto seguem pagos; sem vínculo com o
 * provedor é a cobrança que ficou sem id (a reconciliação não consegue consultar).
 */
export const PAYMENT_REVIEW_REASONS = {
  AMOUNT_MISMATCH: "Valor pago diferente do pedido: reembolsar a diferença ou o pagamento",
  DUPLICATE_PAYMENT_REQUIRES_REFUND: "Pagamento em duplicidade: reembolsar manualmente no provedor",
  PROVIDER_LINK_MISSING: "Cobrança sem id do provedor: conferir no painel do provedor pela referência",
} as const;

export const PAYMENT_REVIEW_WHERE: Prisma.PaymentWhereInput = {
  OR: [
    { failureReason: { in: ["AMOUNT_MISMATCH", "DUPLICATE_PAYMENT_REQUIRES_REFUND"] }, status: "PAID" },
    { failureReason: "PROVIDER_LINK_MISSING", status: "PENDING" },
  ],
};

export async function listPaymentsForReview(db: Db, admin: Actor) {
  assertAdminPermission(admin, "finance:refunds");
  return db.payment.findMany({
    where: PAYMENT_REVIEW_WHERE,
    select: {
      id: true,
      provider: true,
      providerPaymentId: true,
      idempotencyKey: true,
      method: true,
      status: true,
      amountCents: true,
      failureReason: true,
      createdAt: true,
      order: { select: { publicCode: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
  });
}

/** Invariantes financeiros (os mesmos do cron), lidos na hora para a tela do admin. */
export async function adminFinancialChecks(db: Db, admin: Actor) {
  assertAdminPermission(admin, "finance:refunds");
  return checkFinancialInvariants(db);
}

const ORDER_STATUSES: readonly OrderStatus[] = ["PENDING_PAYMENT", "PAID", "PAYMENT_FAILED", "EXPIRED", "CANCELLED", "REFUND_PENDING", "REFUNDED", "DISPUTED"];

export function parseOrderStatus(raw: unknown): OrderStatus | undefined {
  return ORDER_STATUSES.find((s) => s === raw);
}

/** Pedidos (mais recentes primeiro), por código, e-mail do comprador ou título do evento. */
export async function listAdminOrders(db: Db, admin: Actor, opts: { q?: string; status?: OrderStatus; page?: number } = {}) {
  assertAdminPermission(admin, "finance:refunds");
  const q = opts.q?.trim().slice(0, 200) ?? "";
  const where: Prisma.OrderWhereInput = {
    ...(opts.status ? { status: opts.status } : {}),
    ...(q
      ? {
          OR: [
            { publicCode: q.toUpperCase() },
            { buyerEmail: { contains: q, mode: "insensitive" } },
            { event: { title: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const total = await db.order.count({ where });
  const p = paging(opts.page ?? 1, total);
  const items = await db.order.findMany({
    where,
    include: {
      event: { select: { title: true } },
      organization: { select: { name: true } },
      payments: { orderBy: { createdAt: "desc" } },
      // Ingressos que ainda podem entrar num reembolso parcial.
      tickets: {
        where: { status: "VALID", refundId: null },
        select: { id: true, holderName: true, ticketType: { select: { name: true } }, orderItem: { select: { unitPriceCents: true, serviceFeePerUnitCents: true } } },
        orderBy: [{ orderItemId: "asc" }, { sequence: "asc" }],
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: p.skip,
    take: p.take,
  });
  return { items, total, page: p.page, pageCount: p.pageCount, q, status: opts.status };
}

export async function listAdminRefunds(db: Db, admin: Actor, opts: { page?: number } = {}) {
  assertAdminPermission(admin, "finance:refunds");
  const total = await db.refund.count();
  const p = paging(opts.page ?? 1, total);
  const items = await db.refund.findMany({
    include: { order: { select: { publicCode: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: p.skip,
    take: p.take,
  });
  return { items, total, page: p.page, pageCount: p.pageCount };
}

/** Webhooks recebidos; `pendingOnly` mostra só os que ainda não foram processados. */
export async function listWebhookEvents(db: Db, admin: Actor, opts: { page?: number; pendingOnly?: boolean } = {}) {
  assertAdminPermission(admin, "finance:refunds");
  const where: Prisma.PaymentWebhookEventWhereInput = opts.pendingOnly ? { processedAt: null } : {};
  const total = await db.paymentWebhookEvent.count({ where });
  const p = paging(opts.page ?? 1, total);
  const items = await db.paymentWebhookEvent.findMany({
    where,
    select: { id: true, provider: true, eventType: true, receivedAt: true, processedAt: true, processingResult: true, error: true, attempts: true },
    orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
    skip: p.skip,
    take: p.take,
  });
  return { items, total, page: p.page, pageCount: p.pageCount, pendingOnly: !!opts.pendingOnly };
}
