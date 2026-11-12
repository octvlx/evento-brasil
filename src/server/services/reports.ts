// Relatórios calculados a partir do banco (pedidos, ingressos e razão).
import "server-only";
import type { LedgerAccount, Prisma } from "@/generated/prisma/client";
import type { Db } from "../db";
import { formatDateTimeShort } from "@/lib/datetime";
import { effectiveEventStatus } from "@/lib/event-lifecycle";
import { assertEventPermission, assertOrgPermission, assertPlatformAdmin, roleHas, type Actor } from "../auth/permissions";
import { computeHalfPriceState, formatReleaseAt } from "@/features/half-price/quota";
import { HALF_PRICE_EVENT_SELECT, HALF_PRICE_TYPE_SELECT, halfPriceEventInput, loadHalfPriceStateTx } from "./half-price";

export async function organizerOverview(db: Db, actor: Actor, organizationId: string) {
  await assertOrgPermission(db, actor, organizationId, "org:read");
  const [eventsByStatus, ticketsByStatus] = await Promise.all([
    db.event.groupBy({ by: ["status"], where: { organizationId }, _count: true }),
    db.issuedTicket.groupBy({ by: ["status"], where: { event: { organizationId } }, _count: true }),
  ]);
  const ev = Object.fromEntries(eventsByStatus.map((r) => [r.status, r._count])) as Record<string, number>;
  const tk = Object.fromEntries(ticketsByStatus.map((r) => [r.status, r._count])) as Record<string, number>;
  return {
    totalEvents: Object.values(ev).reduce((a, b) => a + b, 0),
    publishedEvents: ev.PUBLISHED ?? 0,
    ticketsSold: (tk.VALID ?? 0) + (tk.CHECKED_IN ?? 0),
    ticketsRevoked: tk.REVOKED ?? 0,
    attendance: tk.CHECKED_IN ?? 0,
  };
}

export interface DashboardAlert {
  tone: "info" | "warning" | "danger";
  text: string;
  href?: string;
}

const PAID_LIKE = ["PAID", "REFUND_PENDING", "REFUNDED", "DISPUTED"] as const;

/** Transferência ainda pendente a menos disso do início do evento vira alerta no painel. */
export const PENDING_TRANSFER_ALERT_HOURS = 72;

/**
 * Dados do painel do organizador. Cada bloco respeita a permissão do papel:
 * financeiro (pedidos recentes, receita por evento) só com `finance:read`;
 * convites pendentes só com `members:manage`.
 */
export async function organizerDashboard(db: Db, actor: Actor, organizationId: string, now = new Date()) {
  const membership = await assertOrgPermission(db, actor, organizationId, "org:read");
  const canFinance = roleHas(membership.role, "finance:read");
  const canManage = roleHas(membership.role, "org:manage");
  const canMembers = roleHas(membership.role, "members:manage");
  const canWrite = roleHas(membership.role, "event:write");
  const canAttendees = roleHas(membership.role, "attendees:read");

  const [org, upcoming, pastCount, pendingReviewCount, invitesPending, pendingTransfers, openWindows] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { status: true, statusReason: true, paymentAccountStatus: true } }),
    db.event.findMany({
      // Só os que ainda não terminaram (pelo relógio, mesmo se o job atrasar).
      where: { organizationId, endsAt: { gt: now }, status: { in: ["DRAFT", "PENDING_REVIEW", "PUBLISHED"] } },
      orderBy: { startsAt: "asc" },
      take: 6,
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        startsAt: true,
        timezone: true,
        capacity: true,
        moderationNote: true,
        _count: { select: { ticketTypes: true, staffAssignments: true } },
      },
    }),
    db.event.count({ where: { organizationId, endsAt: { lte: now } } }),
    db.event.count({ where: { organizationId, status: "PENDING_REVIEW" } }),
    canMembers
      ? db.organizationInvitation.count({ where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } })
      : Promise.resolve(null),
    db.ticketTransfer.groupBy({
      by: ["eventId"],
      where: { status: "PENDING", event: { organizationId, startsAt: { gt: now, lte: new Date(now.getTime() + PENDING_TRANSFER_ALERT_HOURS * 3_600_000) } } },
      _count: true,
    }),
    // Prorrogação só existe com a janela aberta, então qualquer linha com prazo futuro indica janela aberta.
    db.eventChange.findMany({
      where: { organizationId, relevant: true, refundUntil: { gt: now }, event: { status: "PUBLISHED" } },
      distinct: ["eventId"],
      select: { eventId: true, event: { select: { title: true } } },
    }),
  ]);

  const ticketRows = upcoming.length
    ? await db.issuedTicket.groupBy({ by: ["eventId", "status"], where: { eventId: { in: upcoming.map((e) => e.id) } }, _count: true })
    : [];
  const tickets = (eventId: string, statuses: string[]) =>
    ticketRows.filter((r) => r.eventId === eventId && statuses.includes(r.status)).reduce((s, r) => s + r._count, 0);

  const upcomingEvents = upcoming.map((e) => ({
    id: e.id,
    title: e.title,
    slug: e.slug,
    status: e.status,
    startsAt: e.startsAt,
    timezone: e.timezone,
    capacity: e.capacity,
    sold: tickets(e.id, ["VALID", "CHECKED_IN"]),
    checkedIn: tickets(e.id, ["CHECKED_IN"]),
    ticketTypeCount: e._count.ticketTypes,
  }));

  // Pendências acionáveis, da mais grave para a mais leve.
  const alerts: DashboardAlert[] = [];
  if (org.status === "SUSPENDED") alerts.push({ tone: "danger", text: `Organização suspensa: ${org.statusReason ?? "fale com o suporte"}.` });
  if (org.status === "REJECTED")
    alerts.push({ tone: "danger", text: `Cadastro recusado: ${org.statusReason ?? "sem motivo informado"}.`, href: canManage ? "/organizador/cadastro" : undefined });
  if (org.status === "PENDING_REVIEW") alerts.push({ tone: "warning", text: "Cadastro em análise. Você já pode criar rascunhos; a publicação é liberada após a aprovação." });
  if (org.status === "APPROVED" && org.paymentAccountStatus === "NOT_CONNECTED" && canManage)
    alerts.push({ tone: "warning", text: "Conecte a conta de recebimento para vender ingressos pagos.", href: "/organizador/configuracoes" });
  for (const e of upcoming) {
    const edit = canWrite ? `/organizador/eventos/${e.id}/editar` : undefined;
    if (e.status === "DRAFT" && e.moderationNote) alerts.push({ tone: "danger", text: `"${e.title}" foi devolvido pela moderação: ${e.moderationNote}`, href: edit });
    else if (e.status === "DRAFT" && e._count.ticketTypes === 0) alerts.push({ tone: "info", text: `"${e.title}" ainda não tem ingressos cadastrados.`, href: edit });
    const startsInMs = e.startsAt.getTime() - now.getTime();
    if (e.status === "PUBLISHED" && startsInMs < 7 * 86_400_000 && e._count.staffAssignments === 0 && canMembers)
      alerts.push({ tone: "info", text: `"${e.title}" começa em breve e não tem equipe de check-in atribuída.`, href: "/organizador/configuracoes" });
  }
  if (pendingTransfers.length) {
    const titles = new Map(
      (await db.event.findMany({ where: { id: { in: pendingTransfers.map((t) => t.eventId) } }, select: { id: true, title: true } })).map((e) => [e.id, e.title]),
    );
    for (const t of pendingTransfers)
      alerts.push({
        tone: "warning",
        text: `"${titles.get(t.eventId)}" começa em breve e tem ${t._count} transferência(s) de ingresso aguardando aceite.`,
        href: canAttendees ? `/organizador/participantes?evento=${t.eventId}` : undefined,
      });
  }
  for (const w of openWindows)
    alerts.push({ tone: "info", text: `"${w.event.title}" tem janela de reembolso por alteração aberta.`, href: `/organizador/eventos/${w.eventId}/editar` });
  if (pendingReviewCount > 0) alerts.push({ tone: "info", text: `${pendingReviewCount} evento(s) aguardando moderação da plataforma.` });
  if (invitesPending) alerts.push({ tone: "info", text: `${invitesPending} convite(s) de equipe aguardando aceite.`, href: "/organizador/configuracoes" });

  if (!canFinance) return { role: membership.role, upcomingEvents, pastCount, alerts, recentOrders: null, eventPerformance: null };

  const [recentOrders, revenueRows, recentEvents] = await Promise.all([
    db.order.findMany({
      where: { organizationId, status: { in: [...PAID_LIKE] } },
      orderBy: { paidAt: "desc" },
      take: 8,
      select: { id: true, publicCode: true, buyerName: true, totalCents: true, status: true, paidAt: true, isSimulated: true, event: { select: { title: true } } },
    }),
    db.$queryRaw<{ eventId: string; gross: bigint; refunds: bigint }[]>`
      SELECT o."eventId" AS "eventId",
        COALESCE(SUM(CASE WHEN l.type = 'SALE' AND l.account = 'CUSTOMER_FUNDS' AND l.direction = 'DEBIT' THEN l."amountCents" END), 0)::bigint AS gross,
        COALESCE(SUM(CASE WHEN l.type IN ('REFUND', 'CHARGEBACK') AND l.account = 'CUSTOMER_FUNDS' AND l.direction = 'CREDIT' THEN l."amountCents" END), 0)::bigint AS refunds
      FROM "FinancialLedgerEntry" l
      JOIN "Order" o ON o.id = l."orderId"
      WHERE l."organizationId" = ${organizationId}
      GROUP BY o."eventId"`,
    db.event.findMany({
      where: { organizationId, status: { in: ["PUBLISHED", "COMPLETED", "CANCELLED"] } },
      orderBy: { startsAt: "desc" },
      take: 8,
      select: { id: true, title: true, status: true, endsAt: true, capacity: true },
    }),
  ]);
  const soldRows = recentEvents.length
    ? await db.issuedTicket.groupBy({ by: ["eventId"], where: { eventId: { in: recentEvents.map((e) => e.id) }, status: { in: ["VALID", "CHECKED_IN"] } }, _count: true })
    : [];
  const revenue = new Map(revenueRows.map((r) => [r.eventId, { gross: Number(r.gross), refunds: Number(r.refunds) }]));
  const eventPerformance = recentEvents.map((e) => ({
    id: e.id,
    title: e.title,
    status: effectiveEventStatus(e, now),
    capacity: e.capacity,
    sold: soldRows.find((r) => r.eventId === e.id)?._count ?? 0,
    grossCents: revenue.get(e.id)?.gross ?? 0,
    refundCents: revenue.get(e.id)?.refunds ?? 0,
  }));
  return { role: membership.role, upcomingEvents, pastCount, alerts, recentOrders, eventPerformance };
}

/** Saldo por conta do razão (créditos − débitos), opcionalmente por evento. */
async function ledgerBalances(db: Db, where: { organizationId?: string; order?: { eventId: string } }) {
  const rows = await db.financialLedgerEntry.groupBy({ by: ["account", "direction", "type"], where, _sum: { amountCents: true } });
  const sum = (account: LedgerAccount, direction: "DEBIT" | "CREDIT", type?: string) =>
    rows.filter((r) => r.account === account && r.direction === direction && (!type || r.type === type)).reduce((s, r) => s + (r._sum.amountCents ?? 0), 0);
  const simulated = await db.financialLedgerEntry.count({ where: { ...where, isSimulated: true } });
  return {
    grossCents: sum("CUSTOMER_FUNDS", "DEBIT", "SALE"),
    refundCents: sum("CUSTOMER_FUNDS", "CREDIT", "REFUND"),
    chargebackCents: sum("CUSTOMER_FUNDS", "CREDIT", "CHARGEBACK"),
    platformFeeCents:
      sum("PLATFORM_COMMISSION", "CREDIT") - sum("PLATFORM_COMMISSION", "DEBIT") + sum("PLATFORM_SERVICE_FEE", "CREDIT") - sum("PLATFORM_SERVICE_FEE", "DEBIT"),
    processingFeeCents: sum("PROCESSING_FEES", "CREDIT") - sum("PROCESSING_FEES", "DEBIT"),
    organizerNetCents: sum("ORGANIZER_PAYABLE", "CREDIT") - sum("ORGANIZER_PAYABLE", "DEBIT"),
    includesSimulated: simulated > 0,
  };
}

export async function organizerFinancials(db: Db, actor: Actor, organizationId: string) {
  await assertOrgPermission(db, actor, organizationId, "finance:read");
  const [balances, settlements, org] = await Promise.all([
    ledgerBalances(db, { organizationId }),
    db.organizerSettlement.findMany({ where: { organizationId }, orderBy: { periodStart: "desc" }, take: 10 }),
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { paymentAccountStatus: true } }),
  ]);
  return { ...balances, settlements, paymentAccountStatus: org.paymentAccountStatus };
}

export async function dailySales(db: Db, actor: Actor, organizationId: string, days = 30) {
  await assertOrgPermission(db, actor, organizationId, "finance:read");
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.$queryRaw<{ day: string; total: bigint; orders: number }[]>`
    SELECT to_char(("paidAt" AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day,
           SUM("totalCents")::bigint AS total, COUNT(*)::int AS orders
    FROM "Order"
    WHERE "organizationId" = ${organizationId} AND "paidAt" >= ${since}
      AND status IN ('PAID', 'REFUND_PENDING', 'REFUNDED', 'DISPUTED')
    GROUP BY 1 ORDER BY 1`;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86_400_000);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
    return { day: key, totalCents: Number(byDay.get(key)?.total ?? 0), orders: byDay.get(key)?.orders ?? 0 };
  });
}

export async function eventSalesSummary(db: Db, actor: Actor, eventId: string) {
  await assertEventPermission(db, actor, eventId, "finance:read");
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, include: { ticketTypes: { orderBy: { sortOrder: "asc" } } } });
  const { state } = await loadHalfPriceStateTx(db, eventId);
  return {
    event,
    balances: await ledgerBalances(db, { order: { eventId } }),
    // Cota e uso vêm do estado do backend (L7c): cota legal sobre o estoque elegível.
    halfPrice: {
      quota: state.applicable ? state.quota : null,
      used: state.halfCommitted,
      status: state.status,
    },
  };
}

/**
 * Ingressos do evento com o titular ATUAL (R6): depois de uma transferência aceita,
 * `holderUserId`, `holderName` e `holderEmail` são do novo titular; o comprador
 * (quem pagou) continua no pedido. `transferred` = o titular não é mais o comprador.
 */
const ATTENDEE_INCLUDE = {
  ticketType: { select: { name: true, kind: true } },
  order: { select: { publicCode: true, buyerEmail: true } },
  holder: { select: { name: true, email: true } },
  transfers: { where: { status: "PENDING" }, select: { toEmail: true, expiresAt: true }, take: 1 },
  _count: { select: { transfers: true } },
} satisfies Prisma.IssuedTicketInclude;
const ATTENDEE_ORDER = [{ issuedAt: "asc" }, { sequence: "asc" }] satisfies Prisma.IssuedTicketOrderByWithRelationInput[];

function attendeeRow({ holder, transfers, _count, ...t }: Prisma.IssuedTicketGetPayload<{ include: typeof ATTENDEE_INCLUDE }>) {
  return {
    ...t,
    holderName: t.holderName ?? holder.name,
    holderEmail: t.holderEmail ?? holder.email,
    transferred: t.holderUserId !== t.userId,
    pendingTransfer: transfers[0] ?? null,
    transferCount: _count.transfers,
  };
}

/** Todos os participantes do evento (exportação CSV). Na tela, use listAttendeesPage. */
export async function listAttendees(db: Db, actor: Actor, eventId: string) {
  await assertEventPermission(db, actor, eventId, "attendees:read");
  const rows = await db.issuedTicket.findMany({ where: { eventId }, include: ATTENDEE_INCLUDE, orderBy: ATTENDEE_ORDER });
  return rows.map(attendeeRow);
}

export const ATTENDEES_PAGE_SIZE = 50;
export type AttendeeStatusFilter = "VALID" | "CHECKED_IN" | "REVOKED";

/**
 * Participantes de um evento, uma página por vez, com busca (nome ou e-mail do titular,
 * código do ingresso ou do pedido) e filtro de situação. Os totais são do evento inteiro.
 */
export async function listAttendeesPage(
  db: Db,
  actor: Actor,
  eventId: string,
  opts: { page?: number; q?: string; status?: AttendeeStatusFilter; pageSize?: number } = {},
) {
  await assertEventPermission(db, actor, eventId, "attendees:read");
  const pageSize = opts.pageSize ?? ATTENDEES_PAGE_SIZE;
  const q = opts.q?.trim().slice(0, 100) ?? "";
  const text = { contains: q, mode: "insensitive" as const };
  const where: Prisma.IssuedTicketWhereInput = {
    eventId,
    ...(opts.status ? { status: opts.status } : {}),
    ...(q
      ? {
          OR: [
            { code: text },
            { order: { publicCode: text } },
            { holderName: text },
            { holderEmail: text },
            // Sem nome/e-mail no ingresso, vale o da conta do titular (como na tela).
            { holderName: null, holder: { name: text } },
            { holderEmail: null, holder: { email: text } },
          ],
        }
      : {}),
  };
  const [matching, byStatus, transferredRows] = await Promise.all([
    db.issuedTicket.count({ where }),
    db.issuedTicket.groupBy({ by: ["status"], where: { eventId }, _count: { _all: true } }),
    db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "IssuedTicket" WHERE "eventId" = ${eventId} AND "holderUserId" <> "userId"`,
  ]);
  const pageCount = Math.max(1, Math.ceil(matching / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);
  const rows = await db.issuedTicket.findMany({ where, include: ATTENDEE_INCLUDE, orderBy: ATTENDEE_ORDER, skip: (page - 1) * pageSize, take: pageSize });
  const of = (st: string) => byStatus.find((r) => r.status === st)?._count._all ?? 0;
  return {
    rows: rows.map(attendeeRow),
    matching,
    page,
    pageCount,
    totals: { tickets: byStatus.reduce((n, r) => n + r._count._all, 0), checkedIn: of("CHECKED_IN"), transferred: Number(transferredRows[0]?.n ?? 0) },
  };
}

export type TransferHistoryRow = Awaited<ReturnType<typeof listTransferHistory>>[number];

/**
 * Histórico de transferências dos ingressos do evento (de → para, datas, situação),
 * mais antigo primeiro. Dados pessoais: mesma permissão da lista de participantes.
 * Nunca devolve token, IP nem user agent. Com `ticketId`, só daquele(s) ingresso(s).
 */
export async function listTransferHistory(db: Db, actor: Actor, eventId: string, ticketId?: string | string[]) {
  await assertEventPermission(db, actor, eventId, "attendees:read");
  return db.ticketTransfer.findMany({
    where: { eventId, ticket: { eventId }, ...(ticketId === undefined ? {} : { ticketId: Array.isArray(ticketId) ? { in: ticketId } : ticketId }) },
    select: {
      id: true,
      ticketId: true,
      initiatedBy: true,
      fromHolderName: true,
      fromHolderEmail: true,
      toHolderName: true,
      toEmail: true,
      status: true,
      createdAt: true,
      expiresAt: true,
      decidedAt: true,
      ticket: { select: { code: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** Célula CSV entre aspas, com fórmulas de planilha neutralizadas. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutraliza injeção de fórmulas em planilhas.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** CSV com BOM UTF-8 (o Excel reconhece acentos) e quebra de linha CRLF. */
function toCsv(rows: unknown[][], sep = ","): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(sep)).join("\r\n");
}

export function attendeesToCsv(rows: Awaited<ReturnType<typeof listAttendees>>): string {
  const header = ["codigo", "titular", "email_titular", "conta_titular", "transferido", "transferencia_pendente", "tipo", "status", "check_in", "pedido"];
  return toCsv([
    header,
    ...rows.map((t) => [
      t.code,
      t.holderName,
      t.holderEmail,
      t.holderUserId,
      t.transferred ? "sim" : "não",
      t.pendingTransfer ? "sim" : "não",
      t.ticketType.name,
      t.status,
      t.checkedInAt?.toISOString() ?? "",
      t.order.publicCode,
    ]),
  ]);
}

/**
 * Situação da meia-entrada de um evento (R7 do decreto). Só números agregados —
 * nenhum dado pessoal. "Vendidas" é monotônico (inclui as depois reembolsadas
 * ou canceladas), como no estoque; a cota restante segue a regra do checkout:
 * cota − (vendidas + reservadas).
 */
export async function halfPriceReport(db: Db, actor: Actor, eventId: string, now = new Date()) {
  await assertEventPermission(db, actor, eventId, "finance:read");
  const event = await db.event.findUniqueOrThrow({
    where: { id: eventId },
    select: {
      id: true,
      title: true,
      slug: true,
      startsAt: true,
      timezone: true,
      capacity: true,
      halfPriceQuotaBps: true,
      organizationId: true,
      ticketTypes: { where: { kind: "HALF_PRICE" }, select: { quantitySold: true, quantityReserved: true } },
    },
  });
  const [ticketRows, dayRows] = await Promise.all([
    db.issuedTicket.groupBy({ by: ["status", "revocationReason"], where: { eventId, ticketType: { kind: "HALF_PRICE" } }, _count: true }),
    db.$queryRaw<{ day: string; half: number; halfFaceCents: bigint; total: number }[]>`
      SELECT to_char((o."paidAt" AT TIME ZONE ${event.timezone})::date, 'YYYY-MM-DD') AS day,
             COALESCE(SUM(CASE WHEN i.kind = 'HALF_PRICE' THEN i.quantity END), 0)::int AS half,
             COALESCE(SUM(CASE WHEN i.kind = 'HALF_PRICE' THEN i.quantity::bigint * i."unitPriceCents" END), 0)::bigint AS "halfFaceCents",
             SUM(i.quantity)::int AS total
      FROM "Order" o
      JOIN "OrderItem" i ON i."orderId" = o.id
      WHERE o."eventId" = ${eventId} AND o."paidAt" IS NOT NULL
        AND o.status IN ('PAID', 'REFUND_PENDING', 'REFUNDED', 'DISPUTED')
      GROUP BY 1 ORDER BY 1`,
  ]);
  const count = (pred: (r: (typeof ticketRows)[number]) => boolean) => ticketRows.filter(pred).reduce((s, r) => s + r._count, 0);
  const sold = event.ticketTypes.reduce((s, t) => s + t.quantitySold, 0);
  const reserved = event.ticketTypes.reduce((s, t) => s + t.quantityReserved, 0);
  // Cota, limite e saldo: o estado do backend (L7c), nunca uma fórmula local.
  const { state } = await loadHalfPriceStateTx(db, eventId, now);
  const quota = state.applicable ? state.quota : null;
  return {
    event,
    generatedAt: now,
    capacity: event.capacity,
    quotaBps: event.halfPriceQuotaBps,
    quota,
    halfLimit: state.applicable && Number.isFinite(state.halfLimit) ? state.halfLimit : null,
    eligibleStock: state.eligibleStock,
    reserveStatus: state.status,
    deadlineHours: state.deadlineHours,
    releaseAt: state.releaseAt,
    sold,
    reserved,
    refunded: count((r) => r.status === "REVOKED" && r.revocationReason === "REFUNDED"),
    cancelled: count((r) => r.status === "REVOKED" && r.revocationReason === "EVENT_CANCELLED"),
    otherRevoked: count((r) => r.status === "REVOKED" && r.revocationReason !== "REFUNDED" && r.revocationReason !== "EVENT_CANCELLED"),
    valid: count((r) => r.status === "VALID"),
    checkedIn: count((r) => r.status === "CHECKED_IN"),
    remaining: state.applicable ? state.balance : null,
    byDay: dayRows.map((r) => ({ day: r.day, halfSold: r.half, halfFaceCents: Number(r.halfFaceCents), totalSold: r.total })),
  };
}

const HALF_RESERVE_STATUS_LABEL = {
  RESERVED: "Reservada",
  RELEASED: "Liberada",
  EXHAUSTED: "Cota atingida",
  NOT_APPLICABLE: "Não se aplica",
} as const;

/**
 * Controle de meia-entrada do evento (L7c): o estado do backend (`computeHalfPriceState`),
 * sem nenhum cálculo no frontend. Mesma permissão dos relatórios do evento (`finance:read`);
 * evento de outra organização → FORBIDDEN. Só números agregados.
 */
export async function halfPriceControl(db: Db, actor: Actor, eventId: string, now = new Date()) {
  await assertEventPermission(db, actor, eventId, "finance:read");
  const { event, types, state } = await loadHalfPriceStateTx(db, eventId, now);
  const info = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { title: true, slug: true, status: true } });
  const sum = (xs: typeof types) => xs.reduce((s, t) => s + t.quantityTotal, 0);
  return {
    eventId,
    title: info.title,
    eventStatus: info.status,
    timezone: event.timezone,
    startsAt: event.startsAt,
    generatedAt: now,
    regime: event.halfPriceRegime,
    regimeNote: event.halfPriceRegimeNote,
    /** Limite configurado pelo organizador, em % (null = sem limite). Abaixo de 40% vale 40%. */
    configuredLimitPercent: event.halfPriceQuotaBps === null ? null : event.halfPriceQuotaBps / 100,
    status: state.status,
    notApplicableReason: state.notApplicableReason,
    applicable: state.applicable,
    reserveActive: state.reserveActive,
    eligibleStock: state.eligibleStock,
    quota: state.quota,
    /** null = sem limite além da cota. */
    halfLimit: Number.isFinite(state.halfLimit) ? state.halfLimit : null,
    halfSold: state.halfSold,
    halfReserved: state.halfReserved,
    halfCommitted: state.halfCommitted,
    balance: state.balance,
    deadlineHours: state.deadlineHours,
    releaseAt: state.releaseAt,
    releaseAtLabel: formatReleaseAt(state.releaseAt, event.timezone),
    physicalCapacity: state.physicalCapacity,
    eventCapacity: state.eventCapacity,
    /** Estoque à venda ao público (tipos não ocultos) e das meias. */
    onSaleStock: sum(types.filter((t) => !t.isHidden)),
    halfStock: sum(types.filter((t) => t.kind === "HALF_PRICE")),
    /** Indisponíveis para a inteira por causa da reserva. */
    unavailableForFull: state.blocked,
    fullAvailable: state.fullAvailable,
    halfAvailable: state.halfAvailable,
    warnings: state.warnings,
  };
}

/** Uma linha por evento da organização para a tela de vendas: cota, meias e saldo do estado do backend. */
export async function organizerHalfPriceSummary(db: Db, actor: Actor, organizationId: string, now = new Date()) {
  await assertOrgPermission(db, actor, organizationId, "finance:read");
  const events = await db.event.findMany({
    where: { organizationId },
    orderBy: { startsAt: "desc" },
    select: { ...HALF_PRICE_EVENT_SELECT, title: true, ticketTypes: { select: HALF_PRICE_TYPE_SELECT } },
  });
  return events.map(({ ticketTypes, title, ...event }) => {
    const state = computeHalfPriceState(halfPriceEventInput(event), ticketTypes, now);
    return {
      id: event.id,
      title,
      status: state.status,
      quota: state.applicable ? state.quota : null,
      halfCommitted: state.halfCommitted,
      balance: state.applicable ? state.balance : null,
      totalSold: ticketTypes.reduce((s, t) => s + t.quantitySold, 0),
    };
  });
}

const decimalBR = (n: number) => String(n).replace(".", ",");
const centsBR = (c: number) => (c / 100).toFixed(2).replace(".", ",");

/** Separador ";" e decimal com vírgula: o Excel em pt-BR abre em colunas. */
export function halfPriceReportToCsv(r: Awaited<ReturnType<typeof halfPriceReport>>): string {
  const noQuota = "Não se aplica";
  const noLimit = "Sem limite definido";
  return toCsv(
    [
      ["Indicador", "Valor"],
      ["Evento", r.event.title],
      ["Início do evento", formatDateTimeShort(r.event.startsAt, r.event.timezone)],
      ["Capacidade", r.capacity],
      ["Cota de meia-entrada (%)", r.quotaBps === null ? noLimit : decimalBR(r.quotaBps / 100)],
      ["Cota de meia-entrada (ingressos)", r.quota ?? noQuota],
      ["Meias vendidas (inclui reembolsadas e canceladas)", r.sold],
      ["Meias reservadas (pagamento pendente)", r.reserved],
      ["Meias reembolsadas", r.refunded],
      ["Meias canceladas (evento cancelado)", r.cancelled],
      ["Meias revogadas por outro motivo", r.otherRevoked],
      ["Meias válidas sem check-in", r.valid],
      ["Meias com check-in", r.checkedIn],
      ["Cota restante", r.remaining ?? noQuota],
      ["Gerado em", formatDateTimeShort(r.generatedAt, r.event.timezone)],
      ["Estoque elegível (base da cota)", r.eligibleStock],
      ["Limite de meia-entrada (ingressos)", r.halfLimit ?? noLimit],
      ["Situação da reserva", HALF_RESERVE_STATUS_LABEL[r.reserveStatus]],
      ["Prazo da reserva (horas antes do início)", r.deadlineHours],
      ["Liberação da reserva", formatReleaseAt(r.releaseAt, r.event.timezone)],
      [],
      ["Data da venda", "Meias vendidas", "Valor de face das meias (R$)", "Ingressos vendidos (todos os tipos)"],
      ...r.byDay.map((d) => [d.day.split("-").reverse().join("/"), d.halfSold, centsBR(d.halfFaceCents), d.totalSold]),
    ],
    ";",
  );
}

export async function adminStats(db: Db, admin: Actor) {
  assertPlatformAdmin(admin);
  const [orgs, events, ordersByStatus, users, balances, refundsByStatus, webhooksFailed] = await Promise.all([
    db.organization.groupBy({ by: ["status"], _count: true }),
    db.event.groupBy({ by: ["status"], _count: true }),
    db.order.groupBy({ by: ["status"], _count: true, _sum: { totalCents: true } }),
    db.user.count(),
    ledgerBalances(db, {}),
    db.refund.groupBy({ by: ["status"], _count: true }),
    db.paymentWebhookEvent.count({ where: { processedAt: null } }),
  ]);
  const toMap = (rows: { status: string; _count: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r._count])) as Record<string, number>;
  return {
    orgs: toMap(orgs),
    events: toMap(events),
    orders: toMap(ordersByStatus),
    users,
    balances,
    refunds: toMap(refundsByStatus),
    webhooksPending: webhooksFailed,
  };
}

// ── Cupons e origem das vendas (ADR 0002) ──
// Só pedidos PAID: pendentes, expirados e reembolsados ficam de fora. Valores de
// ingresso são líquidos de desconto (`subtotalCents`), sem taxa de serviço.

/** Vendas por origem: link rastreado, senão utm_source, senão "direto". */
export async function salesBySource(db: Db, actor: Actor, organizationId: string) {
  await assertOrgPermission(db, actor, organizationId, "finance:read");
  const groups = await db.order.groupBy({
    by: ["trackingLinkId", "utmSource"],
    where: { organizationId, status: "PAID" },
    _count: { _all: true },
    _sum: { subtotalCents: true, discountCents: true },
  });
  const linkIds = groups.flatMap((g) => (g.trackingLinkId ? [g.trackingLinkId] : []));
  const links = await db.trackingLink.findMany({
    where: { id: { in: linkIds }, organizationId },
    select: { id: true, name: true, code: true, event: { select: { title: true } } },
  });
  return groups
    .map((g) => {
      const link = links.find((l) => l.id === g.trackingLinkId);
      return {
        key: g.trackingLinkId ?? `utm:${g.utmSource ?? ""}`,
        kind: link ? ("link" as const) : g.utmSource ? ("utm" as const) : ("direct" as const),
        label: link ? link.name : (g.utmSource ?? "Direto / sem origem"),
        detail: link ? `${link.event.title} · /r/${link.code}${g.utmSource ? ` · ${g.utmSource}` : ""}` : null,
        orders: g._count._all,
        netTicketCents: g._sum.subtotalCents ?? 0,
        discountCents: g._sum.discountCents ?? 0,
      };
    })
    .sort((a, b) => b.netTicketCents - a.netTicketCents);
}

/** Uso de cada cupom da organização: resgates, pedidos pagos, desconto concedido e valor vendido. */
export async function couponUsage(db: Db, actor: Actor, organizationId: string) {
  await assertOrgPermission(db, actor, organizationId, "finance:read");
  const [coupons, paid] = await Promise.all([
    db.coupon.findMany({
      where: { organizationId },
      select: {
        id: true,
        code: true,
        discountType: true,
        percentBps: true,
        amountCents: true,
        maxUses: true,
        timesReserved: true,
        timesRedeemed: true,
        disabledAt: true,
        event: { select: { title: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.order.groupBy({
      by: ["couponId"],
      where: { organizationId, status: "PAID", couponId: { not: null } },
      _count: { _all: true },
      _sum: { subtotalCents: true, discountCents: true },
    }),
  ]);
  return coupons.map((c) => {
    const g = paid.find((p) => p.couponId === c.id);
    return {
      id: c.id,
      code: c.code,
      eventTitle: c.event?.title ?? null,
      discountType: c.discountType,
      percentBps: c.percentBps,
      amountCents: c.amountCents,
      maxUses: c.maxUses,
      timesReserved: c.timesReserved,
      timesRedeemed: c.timesRedeemed,
      disabled: c.disabledAt !== null,
      paidOrders: g?._count._all ?? 0,
      discountCents: g?._sum.discountCents ?? 0,
      netTicketCents: g?._sum.subtotalCents ?? 0,
    };
  });
}
