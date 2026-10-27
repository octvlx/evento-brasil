// Relatórios calculados a partir do banco (pedidos, ingressos e razão).
import "server-only";
import type { LedgerAccount } from "@/generated/prisma/client";
import type { Db } from "../db";
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

export function attendeesToCsv(rows: Awaited<ReturnType<typeof listAttendees>>): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Neutraliza injeção de fórmulas em planilhas.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const header = ["codigo", "participante", "email", "tipo", "status", "check_in", "pedido"];
  const lines = rows.map((t) =>
    [t.code, t.holderName, t.holderEmail, t.ticketType.name, t.status, t.checkedInAt?.toISOString() ?? "", t.order.publicCode].map(esc).join(","),
  );
  return "﻿" + [header.join(","), ...lines].join("\r\n");
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
