// Consultas públicas: apenas eventos PUBLICADOS, não encerrados, de
// organizações aprovadas.
import "server-only";
import type { CommissionRule, Prisma } from "@/generated/prisma/client";
import { computeFees } from "@/features/fees/policy";
import { localDayRange, weekendRange } from "@/lib/datetime";
import type { PriceQuote } from "@/lib/price-display";
import type { Db } from "../db";
import { resolveCommissionRule } from "./commission";

export const publicEventWhere = (now = new Date()): Prisma.EventWhereInput => ({
  status: "PUBLISHED",
  endsAt: { gt: now },
  organization: { status: "APPROVED" },
});

const cardInclude = {
  city: { select: { name: true, state: true, slug: true } },
  venue: { select: { name: true, city: { select: { name: true, state: true, slug: true } } } },
  category: { select: { name: true, slug: true } },
  ticketTypes: {
    where: { isHidden: false },
    select: { priceCents: true, quantityTotal: true, quantityReserved: true, quantitySold: true, salesStartAt: true, salesEndAt: true },
  },
} satisfies Prisma.EventInclude;

type CardRow = Prisma.EventGetPayload<{ include: typeof cardInclude }>;

export type { PriceQuote };

/**
 * Prévia do preço unitário com a MESMA regra e o MESMO cálculo do pedido
 * (`resolveCommissionRule` + `computeFees`): o valor ofertado é o cobrado.
 */
export function quoteUnitPrice(priceCents: number, rule: Pick<CommissionRule, "policyVersion" | "percentBps" | "fixedCentsPerTicket" | "bearer">): PriceQuote {
  const fees = computeFees([{ ticketTypeId: "preview", unitPriceCents: priceCents, quantity: 1 }], rule);
  return { priceCents, serviceFeeCents: fees.serviceFeeCents, totalCents: fees.totalCents };
}

/** Menor total por ingresso entre os tipos visíveis (null sem ingressos). */
export function minPriceQuote(prices: number[], rule: Parameters<typeof quoteUnitPrice>[1]): PriceQuote | null {
  if (!prices.length) return null;
  return prices.map((p) => quoteUnitPrice(p, rule)).reduce((min, q) => (q.totalCents < min.totalCents ? q : min));
}

/** Regra de comissão vigente de cada evento (uma consulta por evento distinto). */
async function rulesFor(db: Db, rows: { id: string; organizationId: string }[], now: Date) {
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
  const rules = await Promise.all(unique.map((r) => resolveCommissionRule(db, r.organizationId, r.id, now)));
  return new Map(unique.map((r, i) => [r.id, rules[i]]));
}

async function toCards(db: Db, rows: CardRow[], now: Date): Promise<EventCard[]> {
  const rules = await rulesFor(db, rows, now);
  return rows.map((r) => toCard(r, rules.get(r.id)!, now));
}

export type Availability = "AVAILABLE" | "LOW" | "SOLD_OUT" | "NOT_STARTED" | "CLOSED";

export interface EventCard {
  id: string;
  slug: string;
  title: string;
  coverImageUrl: string | null;
  startsAt: Date;
  timezone: string;
  venueName: string | null;
  cityName: string | null;
  state: string | null;
  isOnline: boolean;
  categoryName: string;
  categorySlug: string;
  minPriceCents: number | null;
  /** Menor total por ingresso com a taxa de serviço do comprador. */
  minPrice: PriceQuote | null;
  availability: Availability;
}

export function availabilityOf(
  event: { capacity: number; salesStartAt: Date; salesEndAt: Date },
  types: { quantityTotal: number; quantityReserved: number; quantitySold: number }[],
  now = new Date(),
): Availability {
  if (now < event.salesStartAt) return "NOT_STARTED";
  if (now >= event.salesEndAt) return "CLOSED";
  const committed = types.reduce((s, t) => s + t.quantityReserved + t.quantitySold, 0);
  const typeAvail = types.reduce((s, t) => s + Math.max(0, t.quantityTotal - t.quantityReserved - t.quantitySold), 0);
  const available = Math.min(typeAvail, event.capacity - committed);
  if (available <= 0) return "SOLD_OUT";
  if (available <= Math.max(5, Math.ceil(event.capacity * 0.1))) return "LOW";
  return "AVAILABLE";
}

function toCard(e: CardRow, rule: CommissionRule, now: Date): EventCard {
  const city = e.venue?.city ?? e.city;
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    coverImageUrl: e.coverImageUrl,
    startsAt: e.startsAt,
    timezone: e.timezone,
    venueName: e.venue?.name ?? (e.locationType === "ONLINE" ? "Online" : null),
    cityName: city?.name ?? null,
    state: city?.state ?? null,
    isOnline: e.locationType === "ONLINE",
    categoryName: e.category.name,
    categorySlug: e.category.slug,
    minPriceCents: e.ticketTypes.length ? Math.min(...e.ticketTypes.map((t) => t.priceCents)) : null,
    minPrice: minPriceQuote(e.ticketTypes.map((t) => t.priceCents), rule),
    availability: availabilityOf(e, e.ticketTypes, now),
  };
}

export type DateFilter = "hoje" | "amanha" | "fim-de-semana" | "7-dias" | "30-dias";
export type PriceFilter = "gratis" | "ate-50" | "50-150" | "150-mais";

export interface SearchParams {
  q?: string;
  citySlug?: string;
  categorySlug?: string;
  date?: DateFilter;
  price?: PriceFilter;
  page?: number;
}

export const PAGE_SIZE = 12;

export async function searchEvents(db: Db, params: SearchParams, now = new Date()) {
  const and: Prisma.EventWhereInput[] = [publicEventWhere(now)];
  const tz = "America/Sao_Paulo";
  if (params.q?.trim()) {
    const q = params.q.trim().slice(0, 80);
    and.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { summary: { contains: q, mode: "insensitive" } },
        { venue: { name: { contains: q, mode: "insensitive" } } },
        { organization: { name: { contains: q, mode: "insensitive" } } },
      ],
    });
  }
  if (params.citySlug) and.push({ OR: [{ city: { slug: params.citySlug } }, { venue: { city: { slug: params.citySlug } } }] });
  if (params.categorySlug) and.push({ category: { slug: params.categorySlug } });
  if (params.date) {
    const range =
      params.date === "hoje"
        ? localDayRange(now, tz)
        : params.date === "amanha"
          ? localDayRange(now, tz, 1)
          : params.date === "fim-de-semana"
            ? weekendRange(now, tz)
            : localDayRange(now, tz, 0, params.date === "7-dias" ? 7 : 30);
    // Eventos que acontecem (ao menos em parte) dentro da janela.
    and.push({ startsAt: { lt: range.to }, endsAt: { gt: range.from } });
  }
  if (params.price) {
    const priceWhere: Prisma.IntFilter =
      params.price === "gratis" ? { equals: 0 } : params.price === "ate-50" ? { lte: 5000 } : params.price === "50-150" ? { gte: 5000, lte: 15000 } : { gte: 15000 };
    and.push({ ticketTypes: { some: { isHidden: false, priceCents: priceWhere } } });
  }
  const where = { AND: and };
  const page = Math.max(1, params.page ?? 1);
  const [total, rows] = await Promise.all([
    db.event.count({ where }),
    db.event.findMany({ where, include: cardInclude, orderBy: [{ startsAt: "asc" }, { id: "asc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
  ]);
  return { total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), events: await toCards(db, rows, now) };
}

export async function featuredEvents(db: Db, limit = 6, now = new Date()) {
  const rows = await db.event.findMany({
    where: { ...publicEventWhere(now), isFeatured: true },
    include: cardInclude,
    orderBy: { startsAt: "asc" },
    take: limit,
  });
  return toCards(db, rows, now);
}

export async function eventsInCity(db: Db, citySlug: string, limit = 8, now = new Date()) {
  return (await searchEvents(db, { citySlug }, now)).events.slice(0, limit);
}

export interface CityShelf {
  category: { slug: string; name: string };
  total: number;
  events: EventCard[];
}

/**
 * Vitrine da cidade: destaques e uma faixa por categoria (na ordem das
 * categorias), com os próximos eventos de cada uma.
 */
export async function cityShowcase(db: Db, citySlug: string, perShelf = 10, now = new Date()) {
  const rows = await db.event.findMany({
    where: { AND: [publicEventWhere(now), { OR: [{ city: { slug: citySlug } }, { venue: { city: { slug: citySlug } } }] }] },
    include: { ...cardInclude, category: { select: { name: true, slug: true, sortOrder: true } } },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: 300,
  });
  const byCategory = new Map<string, { sortOrder: number; category: CityShelf["category"]; total: number; rows: typeof rows }>();
  for (const r of rows) {
    const entry = byCategory.get(r.category.slug) ?? { sortOrder: r.category.sortOrder, category: { slug: r.category.slug, name: r.category.name }, total: 0, rows: [] };
    entry.total++;
    if (entry.rows.length < perShelf) entry.rows.push(r);
    byCategory.set(r.category.slug, entry);
  }
  const featuredRows = rows.filter((r) => r.isFeatured).slice(0, 5);
  const groups = [...byCategory.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  // Só os eventos exibidos precisam de preço com taxa.
  const rules = await rulesFor(db, [...featuredRows, ...groups.flatMap((g) => g.rows)], now);
  const card = (r: (typeof rows)[number]) => toCard(r, rules.get(r.id)!, now);
  return {
    total: rows.length,
    featured: featuredRows.map(card),
    shelves: groups.map((g): CityShelf => ({ category: g.category, total: g.total, events: g.rows.map(card) })),
  };
}

export async function weekendEvents(db: Db, limit = 8, now = new Date()) {
  return (await searchEvents(db, { date: "fim-de-semana" }, now)).events.slice(0, limit);
}

export async function listCategories(db: Db) {
  return db.eventCategory.findMany({ orderBy: { sortOrder: "asc" } });
}

export async function listCities(db: Db, opts: { featuredOnly?: boolean } = {}) {
  return db.city.findMany({ where: opts.featuredOnly ? { isFeatured: true } : {}, orderBy: [{ state: "asc" }, { name: "asc" }] });
}

export async function getPublicEvent(db: Db, slug: string, now = new Date()) {
  const event = await db.event.findFirst({
    where: { slug, ...publicEventWhere(now) },
    include: {
      organization: { select: { name: true, slug: true, description: true } },
      category: true,
      city: true,
      venue: { include: { city: true } },
      images: { orderBy: { sortOrder: "asc" } },
      ticketTypes: { where: { isHidden: false }, orderBy: { sortOrder: "asc" } },
    },
  });
  if (!event) return null;
  const halfUsed = event.ticketTypes.filter((t) => t.kind === "HALF_PRICE").reduce((s, t) => s + t.quantityReserved + t.quantitySold, 0);
  const halfQuota = event.halfPriceQuotaBps === null ? null : Math.floor((event.capacity * event.halfPriceQuotaBps) / 10_000);
  const committed = event.ticketTypes.reduce((s, t) => s + t.quantityReserved + t.quantitySold, 0);
  const rule = await resolveCommissionRule(db, event.organizationId, event.id, now);
  return {
    event,
    /** Preço por tipo de ingresso como será cobrado (valor de face + taxa do comprador). */
    prices: Object.fromEntries(event.ticketTypes.map((t) => [t.id, quoteUnitPrice(t.priceCents, rule)])) as Record<string, PriceQuote>,
    buyerPaysFee: rule.bearer === "BUYER",
    availability: availabilityOf(event, event.ticketTypes, now),
    capacityLeft: Math.max(0, event.capacity - committed),
    halfPriceLeft: halfQuota === null ? null : Math.max(0, halfQuota - halfUsed),
  };
}

export async function getPublicOrganizer(db: Db, slug: string, now = new Date()) {
  const org = await db.organization.findFirst({
    where: { slug, status: "APPROVED" },
    select: { id: true, name: true, slug: true, description: true, websiteUrl: true, instagramHandle: true, city: true, createdAt: true },
  });
  if (!org) return null;
  const rows = await db.event.findMany({ where: { ...publicEventWhere(now), organizationId: org.id }, include: cardInclude, orderBy: { startsAt: "asc" } });
  return { org, events: await toCards(db, rows, now) };
}

// ───────────────────────────── Links rastreados (ADR 0002, D5) ─────────────────────────────

// Mesmo formato do CHECK TrackingLink_code_format.
const TRACKING_CODE = /^[A-Za-z0-9]{6,16}$/;

/**
 * Clique num link rastreado: conta o clique (incremento atômico) e devolve o
 * destino e os UTMs do link. Código desconhecido, link arquivado ou evento que
 * não está público → null (o clique não é contado).
 */
export async function recordTrackingClick(db: Db, code: string, now = new Date()) {
  if (!TRACKING_CODE.test(code)) return null;
  const link = await db.trackingLink.findFirst({
    where: { code, archivedAt: null, event: publicEventWhere(now) },
    select: { id: true, utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true, utmTerm: true, event: { select: { slug: true } } },
  });
  if (!link) return null;
  await db.trackingLink.update({ where: { id: link.id }, data: { clicks: { increment: 1 } } });
  return link;
}

/** Código do cupom pré-aplicado por um link deste evento (null se não houver ou estiver desativado). */
export async function trackingLinkCouponCode(db: Db, linkId: string, eventId: string) {
  const link = await db.trackingLink.findFirst({
    where: { id: linkId, eventId, archivedAt: null, coupon: { disabledAt: null } },
    select: { coupon: { select: { code: true } } },
  });
  return link?.coupon?.code ?? null;
}
