// Planos de consulta das telas da Fase 4 num banco DESCARTÁVEL com volume sintético.
//
//   DATABASE_URL=postgresql://…@localhost:<porta>/<banco> \
//     npx tsx --conditions=react-server scripts/query-plans/run.mts --load      # carrega volume.sql (banco vazio)
//   … scripts/query-plans/run.mts --out <arquivo.md> [--json <arquivo.json>]  # EXPLAIN (ANALYZE, BUFFERS)
//
// As consultas vêm dos serviços reais (e das páginas que consultam o Prisma
// direto), capturadas pelo log de consultas do Prisma. Cada SELECT capturado
// roda 5× com EXPLAIN (ANALYZE, BUFFERS) dentro de BEGIN/ROLLBACK; o relatório
// traz a mediana do tempo de execução e o plano da última execução.
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/server/auth/permissions";
import { cityShowcase, featuredEvents, getPublicEvent, searchEvents } from "@/server/services/catalog";
import { listMyTransfers } from "@/server/services/transfers";
import { openChangeRefundWindow } from "@/server/services/refunds";
import { listEventChanges } from "@/server/services/event-changes";
import { listCancellationRequestsForAdmin, listMyCancellationRequests } from "@/server/services/cancellation-requests";
import { listAttendees } from "@/server/services/reports";
import { pendingTermsKinds } from "@/server/services/terms";

const url = new URL(process.env.DATABASE_URL ?? "");
if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  console.error("query-plans só roda em banco local descartável.");
  process.exit(1);
}
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });

if (process.argv.includes("--load")) {
  const { rows } = await pool.query(`SELECT (SELECT count(*) FROM "User") + (SELECT count(*) FROM "Order") AS n`);
  if (Number(rows[0].n) > 0) {
    console.error("O banco já tem dados; volume.sql só roda num banco recém-migrado e vazio.");
    process.exit(1);
  }
  const t0 = Date.now();
  await pool.query(readFileSync(path.join(import.meta.dirname, "volume.sql"), "utf8"));
  // Mapa de visibilidade e estatísticas como numa tabela já assentada (index-only scans).
  await pool.query("VACUUM ANALYZE");
  console.log(`Volume carregado em ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
  await pool.end();
  process.exit(0);
}

type Captured = { scenario: string; query: string; params: unknown[] };
const captured: Captured[] = [];
let scenario = "";
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }), log: [{ emit: "event", level: "query" }] });
db.$on("query", (e: Prisma.QueryEvent) => {
  if (/^\s*SELECT/i.test(e.query)) captured.push({ scenario, query: e.query, params: JSON.parse(e.params) as unknown[] });
});

const now = new Date();
const admin: Actor = { id: "u0", platformRole: "ADMIN", status: "ACTIVE" };
const asUser = (id: string): Actor => ({ id, platformRole: "USER", status: "ACTIVE" });
const one = async (sql: string) => (await pool.query(sql)).rows[0] as Record<string, string>;

// Casos típico e pesado, escolhidos pelo volume.
const heavyBuyer = (await one(`SELECT "userId" AS id FROM "Order" GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)).id;
const typicalBuyer = (await one(`SELECT "userId" AS id FROM "Order" GROUP BY 1 HAVING count(*) BETWEEN 4 AND 6 ORDER BY 1 LIMIT 1`)).id;
const heavyEvent = await one(`SELECT e.id, e.slug, e."organizationId" FROM "Event" e JOIN "Organization" o ON o.id = e."organizationId"
  WHERE e.status = 'PUBLISHED' AND o.status = 'APPROVED' AND e."endsAt" > now()
  ORDER BY (SELECT count(*) FROM "IssuedTicket" t WHERE t."eventId" = e.id) DESC LIMIT 1`);
const heavyEventOwner = (await one(`SELECT "userId" AS id FROM "OrganizationMember" WHERE "organizationId" = '${heavyEvent.organizationId}' AND role = 'OWNER'`)).id;
const changedEvent = (await one(`SELECT "eventId" AS id FROM "EventChange" GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`)).id;
const changedEventOwner = (await one(`SELECT m."userId" AS id FROM "Event" e JOIN "OrganizationMember" m ON m."organizationId" = e."organizationId" WHERE e.id = '${changedEvent}'`)).id;
const someTicket = (await one(`SELECT "ticketId" AS id FROM "TicketTransfer" GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`)).id;
const someTicketCode = (await one(`SELECT code FROM "IssuedTicket" WHERE id = '${someTicket}'`)).code;
const bigCity = (await one(`SELECT c.slug FROM "City" c JOIN "Venue" v ON v."cityId" = c.id GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)).slug;
const smallCity = (await one(`SELECT c.slug FROM "City" c JOIN "Venue" v ON v."cityId" = c.id GROUP BY 1 HAVING count(*) = 1 ORDER BY 1 LIMIT 1`)).slug;
const ADMIN_PAGE = { skip: 0, take: 25 };

const myTickets = (userId: string) =>
  Promise.all([
    // src/app/meus-ingressos/page.tsx
    db.issuedTicket.findMany({
      where: { holderUserId: userId },
      include: { ticketType: { select: { name: true } }, event: { select: { id: true, title: true, slug: true, startsAt: true, endsAt: true, timezone: true, coverImageUrl: true } } },
      orderBy: { event: { startsAt: "asc" } },
    }),
    db.order.findMany({ where: { userId }, include: { event: { select: { title: true } } }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);

const myOrders = (userId: string, statuses?: Prisma.OrderWhereInput["status"]) => {
  // src/app/meus-pedidos/page.tsx
  const where: Prisma.OrderWhereInput = { userId, ...(statuses ? { status: statuses } : {}) };
  return Promise.all([
    db.order.count({ where }),
    db.order.findMany({
      where,
      include: { event: { select: { title: true, startsAt: true, timezone: true, coverImageUrl: true } }, items: { select: { quantity: true } } },
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 15,
    }),
  ]);
};

// Filtros da auditoria e filas do admin (src/server/services/admin-oversight.ts, branch agent/admin, Fase 4).
const auditSearch = async (prefixes: string[], text?: string) => {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (prefixes.length) and.push({ OR: prefixes.map((p) => ({ action: { startsWith: p } })) });
  if (text) and.push({ action: { startsWith: text } });
  const where: Prisma.AuditLogWhereInput = and.length ? { AND: and } : {};
  await db.auditLog.count({ where });
  await db.auditLog.findMany({
    where,
    include: { actor: { select: { email: true } }, organization: { select: { name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...ADMIN_PAGE,
  });
};

const scenarios: [string, () => Promise<unknown>][] = [
  ["descoberta: /eventos sem filtro", () => searchEvents(db, {}, now)],
  [`descoberta: cidade grande (${bigCity})`, () => searchEvents(db, { citySlug: bigCity }, now)],
  [`descoberta: cidade pequena (${smallCity})`, () => searchEvents(db, { citySlug: smallCity }, now)],
  ["descoberta: cidade + categoria + 30 dias", () => searchEvents(db, { citySlug: bigCity, categorySlug: "categoria-3", date: "30-dias" }, now)],
  ["descoberta: categoria", () => searchEvents(db, { categorySlug: "categoria-5" }, now)],
  ["descoberta: fim de semana", () => searchEvents(db, { date: "fim-de-semana" }, now)],
  ["descoberta: busca por texto", () => searchEvents(db, { q: "samba" }, now)],
  ["descoberta: vitrine da cidade", () => cityShowcase(db, bigCity, 10, now)],
  ["descoberta: destaques", () => featuredEvents(db, 6, now)],
  ["página do evento", () => getPublicEvent(db, heavyEvent.slug, now)],
  ["meus ingressos: comprador típico", () => myTickets(typicalBuyer)],
  ["meus ingressos: comprador pesado", () => myTickets(heavyBuyer)],
  ["meus pedidos: típico", () => myOrders(typicalBuyer)],
  ["meus pedidos: pesado, todos", () => myOrders(heavyBuyer)],
  ["meus pedidos: pesado, reembolsos", () => myOrders(heavyBuyer, { in: ["REFUND_PENDING", "REFUNDED"] })],
  ["transferências: minhas (típico)", () => listMyTransfers(db, asUser(typicalBuyer))],
  ["transferências: minhas (pesado)", () => listMyTransfers(db, asUser(heavyBuyer))],
  ["transferências: histórico do ingresso", () => db.ticketTransfer.findMany({ where: { ticketId: someTicket }, orderBy: { createdAt: "desc" } })],
  [
    "transferências: admin por status",
    async () => {
      const where: Prisma.TicketTransferWhereInput = { status: "PENDING" };
      await db.ticketTransfer.count({ where });
      await db.ticketTransfer.findMany({ where, include: { ticket: { select: { code: true } }, event: { select: { title: true } } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...ADMIN_PAGE });
    },
  ],
  [
    "transferências: admin por código do ingresso",
    async () => {
      const q = someTicketCode;
      const where: Prisma.TicketTransferWhereInput = {
        OR: [
          { ticket: { code: q.toUpperCase() } },
          { fromHolderEmail: { contains: q, mode: "insensitive" } },
          { toEmail: { contains: q.toLowerCase() } },
          { event: { title: { contains: q, mode: "insensitive" } } },
        ],
      };
      await db.ticketTransfer.count({ where });
      await db.ticketTransfer.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...ADMIN_PAGE });
    },
  ],
  ["alterações: janela aberta de um evento (reembolso)", () => openChangeRefundWindow(db, changedEvent, new Date(now.getTime() - 30 * 86_400_000), now)],
  ["alterações: histórico do evento (organizador)", () => listEventChanges(db, asUser(changedEventOwner), changedEvent)],
  [
    "alterações: janelas abertas (admin)",
    async () => {
      const where: Prisma.EventChangeWhereInput = { relevant: true, extendsChangeId: null, OR: [{ refundUntil: { gt: now } }, { extensions: { some: { refundUntil: { gt: now } } } }] };
      await db.eventChange.count({ where });
      await db.eventChange.findMany({
        where,
        select: { id: true, eventId: true, refundUntil: true, createdAt: true, event: { select: { title: true } }, organization: { select: { name: true } }, extensions: { select: { refundUntil: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        ...ADMIN_PAGE,
      });
    },
  ],
  ["cancelamento: fila do admin (abertos por prazo)", () => listCancellationRequestsForAdmin(db, admin, { status: "OPEN" })],
  ["cancelamento: decididos (admin)", () => listCancellationRequestsForAdmin(db, admin, { status: "APPROVED" })],
  [
    "cancelamento: vencidos (admin, contagem)",
    () => db.cancellationRequest.count({ where: { status: "OPEN", respondBy: { lt: now } } }),
  ],
  ["cancelamento: meus pedidos (pesado)", () => listMyCancellationRequests(db, asUser(heavyBuyer))],
  [
    "auditoria: página atual, prefixo",
    () =>
      // src/app/admin/auditoria/page.tsx
      db.auditLog.findMany({ where: { action: { startsWith: "ticket.transfer." } }, include: { actor: { select: { email: true } }, organization: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
  ],
  ["auditoria: sem filtro", () => auditSearch([])],
  ["auditoria: preset transferências", () => auditSearch(["ticket.transfer."])],
  ["auditoria: preset alterações (raro)", () => auditSearch(["event.relevant_change", "event.change_"])],
  ["auditoria: preset reembolsos + texto", () => auditSearch(["refund."], "refund.attempt")],
  [
    "participantes: eventos da organização",
    () => db.event.findMany({ where: { organizationId: heavyEvent.organizationId }, select: { id: true, title: true, timezone: true }, orderBy: { startsAt: "desc" } }),
  ],
  ["participantes: lista com titular atual (evento pesado)", () => listAttendees(db, asUser(heavyEventOwner), heavyEvent.id)],
  ["termos: pendentes do usuário", () => pendingTermsKinds(db, typicalBuyer, ["BUYER", "PRIVACY"], now)],
];

const perScenario = new Map<string, number>();
for (const [name, run] of scenarios) {
  scenario = name;
  const before = captured.length;
  await run();
  perScenario.set(name, captured.length - before);
}
await db.$disconnect();

type Result = { scenario: string; query: string; params: unknown[]; medianMs: number; planningMs: number; plan: string };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results: Result[] = [];
const client = await pool.connect();
for (const c of captured) {
  const times: number[] = [];
  let planning = 0;
  let plan = "";
  for (let i = 0; i < 5; i++) {
    await client.query("BEGIN");
    const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${c.query}`, c.params);
    await client.query("ROLLBACK");
    plan = rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
    times.push(Number(/Execution Time: ([\d.]+)/.exec(plan)?.[1] ?? NaN));
    planning = Number(/Planning Time: ([\d.]+)/.exec(plan)?.[1] ?? NaN);
  }
  results.push({ scenario: c.scenario, query: c.query, params: c.params, medianMs: median(times), planningMs: planning, plan });
}
client.release();
await pool.end();

const md: string[] = [`# Planos de consulta (${now.toISOString()})`, ""];
md.push("| Cenário | Consultas | Soma das medianas (ms) | Mais lenta (ms) |", "| --- | ---: | ---: | ---: |");
for (const [name] of scenarios) {
  const rs = results.filter((r) => r.scenario === name);
  md.push(`| ${name} | ${perScenario.get(name)} | ${rs.reduce((s, r) => s + r.medianMs, 0).toFixed(2)} | ${Math.max(0, ...rs.map((r) => r.medianMs)).toFixed(2)} |`);
}
for (const r of results) md.push("", `## ${r.scenario} — ${r.medianMs.toFixed(2)} ms`, "", "```sql", r.query, "```", "", "```", r.plan, "```");
const out = arg("--out");
if (out) writeFileSync(out, md.join("\n"));
else console.log(md.slice(0, scenarios.length + 4).join("\n"));
const json = arg("--json");
if (json) writeFileSync(json, JSON.stringify(results, null, 2));
console.log(md.slice(2, scenarios.length + 4).join("\n"));
