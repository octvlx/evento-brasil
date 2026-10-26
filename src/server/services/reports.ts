// Relatórios calculados a partir do banco (pedidos, ingressos e razão).
import "server-only";
import type { LedgerAccount } from "@/generated/prisma/client";
import type { Db } from "../db";
import { assertEventPermission, assertOrgPermission, assertPlatformAdmin, type Actor } from "../auth/permissions";

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
