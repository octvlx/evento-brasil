// Relatórios calculados a partir do banco (pedidos, ingressos e razão).
import "server-only";
import type { LedgerAccount } from "@/generated/prisma/client";
import type { Db } from "../db";
import { formatDateTimeShort } from "@/lib/datetime";
import { assertEventPermission, assertOrgPermission, assertPlatformAdmin, roleHas, type Actor } from "../auth/permissions";

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

  const [org, upcoming, pastCount, pendingReviewCount, invitesPending] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { status: true, statusReason: true, paymentAccountStatus: true } }),
    db.event.findMany({
      where: { organizationId, endsAt: { gte: now }, status: { in: ["DRAFT", "PENDING_REVIEW", "PUBLISHED"] } },
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
    db.event.count({ where: { organizationId, endsAt: { lt: now } } }),
    db.event.count({ where: { organizationId, status: "PENDING_REVIEW" } }),
    canMembers
      ? db.organizationInvitation.count({ where: { organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } })
      : Promise.resolve(null),
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
    db.$queryRaw<{ eventId: string; gross: number; refunds: number }[]>`
      SELECT o."eventId" AS "eventId",
        COALESCE(SUM(CASE WHEN l.type = 'SALE' AND l.account = 'CUSTOMER_FUNDS' AND l.direction = 'DEBIT' THEN l."amountCents" END), 0)::int AS gross,
        COALESCE(SUM(CASE WHEN l.type IN ('REFUND', 'CHARGEBACK') AND l.account = 'CUSTOMER_FUNDS' AND l.direction = 'CREDIT' THEN l."amountCents" END), 0)::int AS refunds
      FROM "FinancialLedgerEntry" l
      JOIN "Order" o ON o.id = l."orderId"
      WHERE l."organizationId" = ${organizationId}
      GROUP BY o."eventId"`,
    db.event.findMany({
      where: { organizationId, status: { in: ["PUBLISHED", "COMPLETED", "CANCELLED"] } },
      orderBy: { startsAt: "desc" },
      take: 8,
      select: { id: true, title: true, status: true, capacity: true },
    }),
  ]);
  const soldRows = recentEvents.length
    ? await db.issuedTicket.groupBy({ by: ["eventId"], where: { eventId: { in: recentEvents.map((e) => e.id) }, status: { in: ["VALID", "CHECKED_IN"] } }, _count: true })
    : [];
  const revenue = new Map(revenueRows.map((r) => [r.eventId, r]));
  const eventPerformance = recentEvents.map((e) => ({
    id: e.id,
    title: e.title,
    status: e.status,
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
    processingFeeCents: sum("PROCESSING_FEES", "CREDIT"),
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
  const rows = await db.$queryRaw<{ day: string; total: number; orders: number }[]>`
    SELECT to_char(("paidAt" AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day,
           SUM("totalCents")::int AS total, COUNT(*)::int AS orders
    FROM "Order"
    WHERE "organizationId" = ${organizationId} AND "paidAt" >= ${since}
      AND status IN ('PAID', 'REFUND_PENDING', 'REFUNDED', 'DISPUTED')
    GROUP BY 1 ORDER BY 1`;
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86_400_000);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
    return { day: key, totalCents: byDay.get(key)?.total ?? 0, orders: byDay.get(key)?.orders ?? 0 };
  });
}

export async function eventSalesSummary(db: Db, actor: Actor, eventId: string) {
  await assertEventPermission(db, actor, eventId, "finance:read");
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, include: { ticketTypes: { orderBy: { sortOrder: "asc" } } } });
  const halfUsed = event.ticketTypes.filter((t) => t.kind === "HALF_PRICE").reduce((s, t) => s + t.quantitySold + t.quantityReserved, 0);
  return {
    event,
    balances: await ledgerBalances(db, { order: { eventId } }),
    halfPrice: {
      quota: event.halfPriceQuotaBps === null ? null : Math.floor((event.capacity * event.halfPriceQuotaBps) / 10_000),
      used: halfUsed,
    },
  };
}

export async function listAttendees(db: Db, actor: Actor, eventId: string) {
  await assertEventPermission(db, actor, eventId, "attendees:read");
  return db.issuedTicket.findMany({
    where: { eventId },
    include: { ticketType: { select: { name: true, kind: true } }, order: { select: { publicCode: true, buyerEmail: true } } },
    orderBy: [{ issuedAt: "asc" }, { sequence: "asc" }],
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
  const header = ["codigo", "participante", "email", "tipo", "status", "check_in", "pedido"];
  return toCsv([
    header,
    ...rows.map((t) => [t.code, t.holderName, t.holderEmail, t.ticketType.name, t.status, t.checkedInAt?.toISOString() ?? "", t.order.publicCode]),
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
    db.$queryRaw<{ day: string; half: number; halfFaceCents: number; total: number }[]>`
      SELECT to_char((o."paidAt" AT TIME ZONE ${event.timezone})::date, 'YYYY-MM-DD') AS day,
             COALESCE(SUM(CASE WHEN i.kind = 'HALF_PRICE' THEN i.quantity END), 0)::int AS half,
             COALESCE(SUM(CASE WHEN i.kind = 'HALF_PRICE' THEN i.quantity * i."unitPriceCents" END), 0)::int AS "halfFaceCents",
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
  const quota = event.halfPriceQuotaBps === null ? null : Math.floor((event.capacity * event.halfPriceQuotaBps) / 10_000);
  return {
    event,
    generatedAt: now,
    capacity: event.capacity,
    quotaBps: event.halfPriceQuotaBps,
    quota,
    sold,
    reserved,
    refunded: count((r) => r.status === "REVOKED" && r.revocationReason === "REFUNDED"),
    cancelled: count((r) => r.status === "REVOKED" && r.revocationReason === "EVENT_CANCELLED"),
    otherRevoked: count((r) => r.status === "REVOKED" && r.revocationReason !== "REFUNDED" && r.revocationReason !== "EVENT_CANCELLED"),
    valid: count((r) => r.status === "VALID"),
    checkedIn: count((r) => r.status === "CHECKED_IN"),
    remaining: quota === null ? null : Math.max(0, quota - sold - reserved),
    byDay: dayRows.map((r) => ({ day: r.day, halfSold: r.half, halfFaceCents: r.halfFaceCents, totalSold: r.total })),
  };
}

const decimalBR = (n: number) => String(n).replace(".", ",");
const centsBR = (c: number) => (c / 100).toFixed(2).replace(".", ",");

/** Separador ";" e decimal com vírgula: o Excel em pt-BR abre em colunas. */
export function halfPriceReportToCsv(r: Awaited<ReturnType<typeof halfPriceReport>>): string {
  const noQuota = "Sem cota definida";
  return toCsv(
    [
      ["Indicador", "Valor"],
      ["Evento", r.event.title],
      ["Início do evento", formatDateTimeShort(r.event.startsAt, r.event.timezone)],
      ["Capacidade", r.capacity],
      ["Cota de meia-entrada (%)", r.quotaBps === null ? noQuota : decimalBR(r.quotaBps / 100)],
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
