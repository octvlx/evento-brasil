// Consultas públicas: apenas eventos PUBLICADOS, não encerrados, de
// organizações aprovadas.
import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { localDayRange, weekendRange } from "@/lib/datetime";
import type { Db } from "../db";

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
  minPriceCents: number | null;
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

function toCard(e: CardRow, now: Date): EventCard {
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
    minPriceCents: e.ticketTypes.length ? Math.min(...e.ticketTypes.map((t) => t.priceCents)) : null,
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
  return { total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), events: rows.map((r) => toCard(r, now)) };
}

export async function featuredEvents(db: Db, limit = 6, now = new Date()) {
  const rows = await db.event.findMany({
    where: { ...publicEventWhere(now), isFeatured: true },
    include: cardInclude,
    orderBy: { startsAt: "asc" },
    take: limit,
  });
  return rows.map((r) => toCard(r, now));
}

export async function eventsInCity(db: Db, citySlug: string, limit = 8, now = new Date()) {
  return (await searchEvents(db, { citySlug }, now)).events.slice(0, limit);
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
  return {
    event,
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
  return { org, events: rows.map((r) => toCard(r, now)) };
}
