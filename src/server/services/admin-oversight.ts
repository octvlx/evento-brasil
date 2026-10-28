// Leituras das filas do admin (Fase 4): pedidos de cancelamento, transferências,
// janelas de reembolso por alteração e auditoria. Somente leitura: as decisões
// passam pelos serviços de domínio (cancellation-requests, refunds), que
// continuam sendo a fonte da verdade.
import "server-only";
import type { CancellationRequestStatus, Prisma, TicketTransferStatus } from "@/generated/prisma/client";
import type { Db } from "../db";
import { assertPlatformAdmin, type Actor } from "../auth/permissions";
import { notFound } from "../errors";
import { openChangeRefundWindow, refundEligibility } from "./refunds";

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
  assertPlatformAdmin(admin);
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
    db.refund.count({ where: { status: "FAILED", order: { status: "REFUND_PENDING" } } }),
  ]);
  return { openCancellations, overdueCancellations, failedRefunds };
}

/** Detalhe para decidir: pedido, pagamentos, reembolsos e a elegibilidade de hoje pela política. */
export async function getCancellationRequestDetail(db: Db, admin: Actor, requestId: string, now = new Date()) {
  assertPlatformAdmin(admin);
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
  assertPlatformAdmin(admin);
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
  assertPlatformAdmin(admin);
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
  assertPlatformAdmin(admin);
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

export async function listAuditLogs(db: Db, admin: Actor, opts: { preset?: AuditPreset; action?: string; page?: number } = {}) {
  assertPlatformAdmin(admin);
  const prefixes: string[] = opts.preset ? [...AUDIT_PRESETS[opts.preset].prefixes] : [];
  const text = opts.action?.trim().slice(0, 100);
  const and: Prisma.AuditLogWhereInput[] = [];
  if (prefixes.length) and.push({ OR: prefixes.map((p) => ({ action: { startsWith: p } })) });
  if (text) and.push({ action: { startsWith: text } });
  const where: Prisma.AuditLogWhereInput = and.length ? { AND: and } : {};
  const total = await db.auditLog.count({ where });
  const p = paging(opts.page ?? 1, total);
  const items = await db.auditLog.findMany({
    where,
    include: { actor: { select: { email: true } }, organization: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: p.skip,
    take: p.take,
  });
  return { items, total, page: p.page, pageCount: p.pageCount };
}
