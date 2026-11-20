// Consultas públicas: apenas eventos PUBLICADOS, não encerrados, de
// organizações aprovadas.
import "server-only";
import { Prisma, type CommissionRule } from "@/generated/prisma/client";
import { computeFees } from "@/features/fees/policy";
import {
  computeHalfPriceState,
  ticketAvailability,
  type HalfPriceEventInput,
  type HalfPriceStatus,
  type HalfPriceTypeInput,
  type TicketUnavailableReason,
} from "@/features/half-price/quota";
import { localDayRange, weekendRange } from "@/lib/datetime";
import { hasEventEnded } from "@/lib/event-lifecycle";
import type { PriceQuote } from "@/lib/price-display";
import type { Db } from "../db";
import { resolveCommissionRule, resolveCommissionRules } from "./commission";
import { halfPriceEventInput } from "./half-price";
import { rankPublicEventPage, type RankOptions } from "./search-ranking";
import { publicExternalWhere } from "./external-visibility";

export const publicEventWhere = (now = new Date()): Prisma.EventWhereInput => ({
  status: "PUBLISHED",
  endsAt: { gt: now },
  organization: { status: "APPROVED" },
});

// Cards do not need full descriptions, policies, or organizer-only event fields.
const cardSelect = {
  id: true,
  organizationId: true,
  slug: true,
  title: true,
  coverImageUrl: true,
  startsAt: true,
  timezone: true,
  locationType: true,
  capacity: true,
  salesStartAt: true,
  salesEndAt: true,
  isFeatured: true,
  // Para a disponibilidade usar a mesma regra da meia-entrada do pedido (L7c).
  halfPriceQuotaBps: true,
  halfPriceRegime: true,
  city: { select: { name: true, state: true, slug: true } },
  venue: { select: { name: true, capacity: true, city: { select: { name: true, state: true, slug: true } } } },
  category: { select: { name: true, slug: true } },
  ticketTypes: {
    select: { id: true, isHidden: true, kind: true, priceCents: true, quantityTotal: true, quantityReserved: true, quantitySold: true, salesStartAt: true, salesEndAt: true },
  },
} satisfies Prisma.EventSelect;

type CardRow = Prisma.EventGetPayload<{ select: typeof cardSelect }>;

export type { PriceQuote };

/**
 * Prévia do preço unitário com a MESMA regra e o MESMO cálculo do pedido
 * (`resolveCommissionRule` + `computeFees`): o valor ofertado é o cobrado.
 */
export function quoteUnitPrice(
  priceCents: number,
  rule: Pick<CommissionRule, "policyVersion" | "percentBps" | "fixedCentsPerTicket" | "bearer">,
  halfPrice = false,
): PriceQuote {
  const fees = computeFees([{ ticketTypeId: "preview", unitPriceCents: priceCents, quantity: 1, halfPrice }], rule);
  return { priceCents, serviceFeeCents: fees.serviceFeeCents, totalCents: fees.totalCents };
}

/** Menor total por ingresso entre os tipos visíveis (null sem ingressos). */
export function minPriceQuote(types: { priceCents: number; kind: string }[], rule: Parameters<typeof quoteUnitPrice>[1]): PriceQuote | null {
  if (!types.length) return null;
  return types.map((t) => quoteUnitPrice(t.priceCents, rule, t.kind === "HALF_PRICE")).reduce((min, q) => (q.totalCents < min.totalCents ? q : min));
}

/** Regra de comissão vigente, sem consultas repetidas por evento. */
async function rulesFor(db: Db, rows: { id: string; organizationId: string }[], now: Date) {
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
  return resolveCommissionRules(db, unique, now);
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

type AvailabilityType = {
  quantityTotal: number;
  quantityReserved: number;
  quantitySold: number;
  isHidden?: boolean;
  salesStartAt?: Date | null;
  salesEndAt?: Date | null;
  id?: string;
  kind?: string;
  priceCents?: number;
};

/**
 * Disponibilidade resumida (cards, busca, página). Com `half` (entrada da regra da
 * meia-entrada, L7c) e tipos com id/kind/preço, o estoque de cada tipo vem de
 * `ticketAvailability` — o mesmo que `createOrder` aceita, inclusive a reserva da cota.
 * Aproximação deliberada: o selo LOW soma o disponível por tipo (limitado pela
 * capacidade livre), o que pode superestimar quando inteira e meia disputam o mesmo
 * saldo; SOLD_OUT só aparece quando nenhum tipo público tem ingresso comprável.
 * Sem `half`, vale a conta simples por tipo e capacidade.
 */
export function availabilityOf(
  event: { capacity: number; salesStartAt: Date; salesEndAt: Date },
  types: AvailabilityType[],
  now = new Date(),
  half?: HalfPriceEventInput,
): Availability {
  if (now < event.salesStartAt) return "NOT_STARTED";
  if (now >= event.salesEndAt) return "CLOSED";
  const committed = types.reduce((s, t) => s + t.quantityReserved + t.quantitySold, 0);
  const visible = types.filter((t) => !t.isHidden);
  const typed = half && types.every((t) => t.id !== undefined && t.kind !== undefined && t.priceCents !== undefined);
  const byType = typed ? ticketAvailability(computeHalfPriceState(half, types as HalfPriceTypeInput[], now), types as HalfPriceTypeInput[]) : null;
  const stock = (t: AvailabilityType) => byType?.get(t.id!)?.available ?? Math.max(0, t.quantityTotal - t.quantityReserved - t.quantitySold);
  const active = visible.filter((t) => (!t.salesStartAt || now >= t.salesStartAt) && (!t.salesEndAt || now < t.salesEndAt));
  const typeAvail = active.reduce((s, t) => s + stock(t), 0);
  if (event.capacity <= committed || !visible.some((t) => stock(t) > 0)) return "SOLD_OUT";
  if (!typeAvail) return visible.some((t) => stock(t) > 0 && t.salesStartAt && now < t.salesStartAt && (!t.salesEndAt || now < t.salesEndAt)) ? "NOT_STARTED" : "CLOSED";
  const available = Math.min(typeAvail, event.capacity - committed);
  if (available <= 0) return "SOLD_OUT";
  if (available <= Math.max(5, Math.ceil(event.capacity * 0.1))) return "LOW";
  return "AVAILABLE";
}

function toCard(e: CardRow, rule: CommissionRule, now: Date): EventCard {
  const city = e.venue?.city ?? e.city;
  const visibleTypes = e.ticketTypes.filter((t) => !t.isHidden);
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
    minPriceCents: visibleTypes.length ? Math.min(...visibleTypes.map((t) => t.priceCents)) : null,
    minPrice: minPriceQuote(visibleTypes, rule),
    availability: availabilityOf(e, e.ticketTypes, now, halfPriceEventInput(e)),
  };
}

export type DateFilter = "hoje" | "amanha" | "fim-de-semana" | "7-dias" | "30-dias";
/** Ordem dos resultados. Padrão: relevância com texto; data sem texto. */
export type SortOrder = "relevancia" | "data" | "preco-menor" | "preco-maior";
export const SORT_ORDERS: readonly SortOrder[] = ["relevancia", "data", "preco-menor", "preco-maior"];
/** Teto de resultados reordenados por data/preço numa busca com texto (o ranking corta antes). */
export const SORT_RANKED_MAX = 1000;
export type PriceFilter = "gratis" | "ate-50" | "50-150" | "150-mais";

export interface SearchParams {
  /** Texto livre (já sem a localização interpretada; ver services/search.ts). */
  q?: string;
  /** Categoria reconhecida no texto ("teatro"): também conta como correspondência. */
  matchCategoryId?: string;
  citySlug?: string;
  categorySlug?: string;
  date?: DateFilter;
  price?: PriceFilter;
  sort?: SortOrder;
  page?: number;
}

/**
 * Uma página de ids na ordem pedida: data (início, id) ou menor preço visível (sem
 * ingresso visível vai para o fim; empate por data).
 */
async function orderedIdPage(db: Db, ids: string[], sort: "data" | "preco-menor" | "preco-maior", offset: number, take: number): Promise<string[]> {
  if (!ids.length) return [];
  if (sort === "data") {
    const rows = await db.event.findMany({ where: { id: { in: ids } }, select: { id: true }, orderBy: [{ startsAt: "asc" }, { id: "asc" }], skip: offset, take });
    return rows.map((r) => r.id);
  }
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM "Event" e
    LEFT JOIN LATERAL (SELECT min(t."priceCents") AS p FROM "TicketType" t WHERE t."eventId" = e.id AND NOT t."isHidden") m ON true
    WHERE e.id = ANY(${ids})
    ORDER BY ${sort === "preco-menor" ? Prisma.sql`m.p ASC NULLS LAST` : Prisma.sql`m.p DESC NULLS LAST`}, e."startsAt" ASC, e.id ASC
    OFFSET ${offset} LIMIT ${take}`;
  return rows.map((r) => r.id);
}

export const PAGE_SIZE = 12;

/** Janela de um filtro de data (fuso de Brasília), a mesma para eventos nativos e externos. */
export function dateFilterRange(date: DateFilter, now = new Date()) {
  const tz = "America/Sao_Paulo";
  return date === "hoje"
    ? localDayRange(now, tz)
    : date === "amanha"
      ? localDayRange(now, tz, 1)
      : date === "fim-de-semana"
        ? weekendRange(now, tz)
        : localDayRange(now, tz, 0, date === "7-dias" ? 7 : 30);
}

export async function searchEvents(db: Db, params: SearchParams, now = new Date()) {
  const and: Prisma.EventWhereInput[] = [publicEventWhere(now)];
  // Texto: relevância e acentos no banco (search-ranking.ts); a ordem vem do ranking.
  const q = params.q?.trim().slice(0, 80) ?? "";
  const rankFilters: RankOptions = { citySlug: params.citySlug, categorySlug: params.categorySlug, categoryId: params.matchCategoryId, now };
  if (params.citySlug) and.push({ OR: [{ city: { slug: params.citySlug } }, { venue: { city: { slug: params.citySlug } } }] });
  if (params.categorySlug) and.push({ category: { slug: params.categorySlug } });
  if (params.date) {
    const range = dateFilterRange(params.date, now);
    // Eventos que acontecem (ao menos em parte) dentro da janela.
    and.push({ startsAt: { lt: range.to }, endsAt: { gt: range.from } });
    rankFilters.dateRange = range;
  }
  if (params.price) {
    const priceWhere: Prisma.IntFilter =
      params.price === "gratis" ? { equals: 0 } : params.price === "ate-50" ? { lte: 5000 } : params.price === "50-150" ? { gte: 5000, lte: 15000 } : { gte: 15000 };
    and.push({ ticketTypes: { some: { isHidden: false, priceCents: priceWhere } } });
    rankFilters.priceRange = { min: typeof priceWhere.equals === "number" ? priceWhere.equals : typeof priceWhere.gte === "number" ? priceWhere.gte : 0, max: typeof priceWhere.equals === "number" ? priceWhere.equals : typeof priceWhere.lte === "number" ? priceWhere.lte : undefined };
  }
  const where = { AND: and };
  const requestedPage = params.page ?? 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && (requestedPage - 1) * PAGE_SIZE <= 2_147_483_647 ? requestedPage : 1;
  const sort = params.sort && params.sort !== "relevancia" ? params.sort : null;
  const byIds = async (ids: string[]) => {
    const order = new Map(ids.map((id, i) => [id, i]));
    return (await db.event.findMany({ where: { id: { in: ids } }, select: cardSelect })).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  };
  if ((q || params.matchCategoryId) && sort) {
    // Texto com outra ordem: os resultados do ranking (até SORT_RANKED_MAX) reordenados.
    const ranked = await rankPublicEventPage(db, q, rankFilters, 0, SORT_RANKED_MAX);
    const matching = (await db.event.findMany({ where: { AND: [where, { id: { in: ranked.ids } }] }, select: { id: true } })).map((r) => r.id);
    const total = Math.min(ranked.total, matching.length);
    const ids = await orderedIdPage(db, matching, sort, (page - 1) * PAGE_SIZE, PAGE_SIZE);
    return { total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), events: await toCards(db, await byIds(ids), now) };
  }
  if (!(q || params.matchCategoryId) && (sort === "preco-menor" || sort === "preco-maior")) {
    const matching = (await db.event.findMany({ where, select: { id: true } })).map((r) => r.id);
    const ids = await orderedIdPage(db, matching, sort, (page - 1) * PAGE_SIZE, PAGE_SIZE);
    return { total: matching.length, page, pageCount: Math.max(1, Math.ceil(matching.length / PAGE_SIZE)), events: await toCards(db, await byIds(ids), now) };
  }
  if (q || params.matchCategoryId) {
    // Todos os filtros são aplicados antes do ranking; contagem e paginação no banco.
    const ranked = await rankPublicEventPage(db, q, rankFilters, (page - 1) * PAGE_SIZE, PAGE_SIZE);
    const order = new Map(ranked.ids.map((id, i) => [id, i]));
    const rows = (await db.event.findMany({ where: { AND: [where, { id: { in: ranked.ids } }] }, select: cardSelect })).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return { total: ranked.total, page, pageCount: Math.max(1, Math.ceil(ranked.total / PAGE_SIZE)), events: await toCards(db, rows, now) };
  }
  const [total, rows] = await Promise.all([
    db.event.count({ where }),
    db.event.findMany({ where, select: cardSelect, orderBy: [{ startsAt: "asc" }, { id: "asc" }], skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
  ]);
  return { total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), events: await toCards(db, rows, now) };
}

export async function featuredEvents(db: Db, limit = 6, now = new Date()) {
  const rows = await db.event.findMany({
    // Destaque só com venda aberta: encerrou a venda (ou o evento), sai do destaque sozinho.
    where: { ...publicEventWhere(now), isFeatured: true, salesEndAt: { gt: now } },
    select: cardSelect,
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
    select: { ...cardSelect, category: { select: { name: true, slug: true, sortOrder: true } } },
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
  const featuredRows = rows.filter((r) => r.isFeatured && r.salesEndAt > now).slice(0, 5);
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

/**
 * Cidade com ao menos um evento público (direto ou pelo local). Rascunho, evento
 * em análise, cancelado ou encerrado não contam: a cidade criada ao salvar um
 * rascunho só aparece no site quando o evento for publicado.
 */
export const cityWithPublicEventsWhere = (now = new Date()): Prisma.CityWhereInput => ({
  OR: [
    { events: { some: publicEventWhere(now) } },
    { venues: { some: { events: { some: publicEventWhere(now) } } } },
    // Evento externo publicado também torna a cidade pública (sugestões, filtros, página da cidade).
    { externalEvents: { some: publicExternalWhere(now) } },
  ],
});

/** Cidades para seletores e filtros públicos: só as com evento público. Destaques primeiro. */
export async function listCities(db: Db, opts: { now?: Date } = {}) {
  return db.city.findMany({ where: cityWithPublicEventsWhere(opts.now), orderBy: [{ isFeatured: "desc" }, { state: "asc" }, { name: "asc" }] });
}

/** Página pública da cidade: null se não houver evento público nela. */
export async function getPublicCity(db: Db, slug: string, now = new Date()) {
  return db.city.findFirst({ where: { slug, ...cityWithPublicEventsWhere(now) } });
}

/**
 * Página do evento. Diferente das listagens, continua acessível depois do término
 * (com `ended` e sem venda): quem tem ingresso ou um link antigo ainda a consulta.
 */
export async function getPublicEvent(db: Db, slug: string, now = new Date()) {
  const event = await db.event.findFirst({
    where: { slug, status: { in: ["PUBLISHED", "COMPLETED"] }, organization: { status: "APPROVED" } },
    include: {
      organization: { select: { name: true, slug: true, description: true } },
      category: true,
      city: true,
      venue: { include: { city: true } },
      images: { orderBy: { sortOrder: "asc" } },
      ticketTypes: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!event) return null;
  const ended = hasEventEnded(event, now);
  const committed = event.ticketTypes.reduce((s, t) => s + t.quantityReserved + t.quantitySold, 0);
  // Estado da cota de meia-entrada (L7c) calculado no servidor; a página só exibe.
  const halfState = computeHalfPriceState(halfPriceEventInput(event), event.ticketTypes, now);
  const byType = ticketAvailability(halfState, event.ticketTypes);
  const [rule, organizer] = await Promise.all([resolveCommissionRule(db, event.organizationId, event.id, now), organizerIdentification(db, event.organizationId)]);
  return {
    event: {
      ...event,
      // Link de acesso reservado aos compradores; nunca vai para dados públicos/SEO.
      onlineUrl: null,
      ticketTypes: event.ticketTypes
        .filter((t) => !t.isHidden)
        .map((t) => ({ ...t, available: byType.get(t.id)?.available ?? 0, unavailableReason: byType.get(t.id)?.reason ?? null })),
    },
    /** Identificação do organizador responsável (L10b); null sem verificação aprovada. */
    organizer,
    /** Preço por tipo de ingresso como será cobrado (valor de face + taxa do comprador). */
    prices: Object.fromEntries(event.ticketTypes.filter((t) => !t.isHidden).map((t) => [t.id, quoteUnitPrice(t.priceCents, rule, t.kind === "HALF_PRICE")])) as Record<string, PriceQuote>,
    buyerPaysFee: rule.bearer === "BUYER",
    /** Término passado (pelo relógio, mesmo com o status ainda PUBLISHED): sem venda. */
    ended,
    availability: ended ? ("CLOSED" as const) : availabilityOf(event, event.ticketTypes, now, halfPriceEventInput(event)),
    capacityLeft: Math.max(0, event.capacity - committed),
    halfPrice: publicHalfPrice(halfState),
  };
}

/** Estado público mínimo da meia-entrada: sem números internos (estoque elegível, cota, vendidas, avisos). */
export interface PublicHalfPrice {
  status: HalfPriceStatus;
  /** A reserva legal está barrando parte das inteiras agora (antes do prazo). */
  reserveActive: boolean;
  /** Instante em que a reserva termina (início − 48/72 h). */
  releaseAt: Date;
  deadlineHours: number;
  halfAvailable: number;
  fullAvailable: number;
  halfUnavailableReason: "QUOTA_EXHAUSTED" | "SOLD_OUT" | null;
}

export type PublicTicketUnavailableReason = TicketUnavailableReason;

function publicHalfPrice(s: ReturnType<typeof computeHalfPriceState>): PublicHalfPrice {
  return {
    status: s.status,
    reserveActive: s.reserveActive,
    releaseAt: s.releaseAt,
    deadlineHours: s.deadlineHours,
    halfAvailable: s.halfAvailable,
    fullAvailable: s.fullAvailable,
    halfUnavailableReason: s.halfUnavailableReason,
  };
}

export interface OrganizerIdentification {
  legalType: "INDIVIDUAL" | "COMPANY";
  /** Razão social (empresa) ou nome do responsável (pessoa física), da verificação aprovada. */
  legalName: string;
  /** Só para CNPJ: os 4 últimos dígitos, já guardados em claro. CPF nunca é exposto. */
  cnpjLast4: string | null;
}

/**
 * Organizador responsável pelo evento (Decreto 13.108/2026, L10b), só com o que já é
 * seguro tornar público: nome/razão social da verificação APROVADA mais recente e o final
 * do CNPJ. O documento completo fica cifrado (documentEncrypted) e não é decifrado aqui.
 * TODO(jurídico): confirmar se o CNPJ completo precisa aparecer (exigiria decifrar).
 */
export async function organizerIdentification(db: Db, organizationId: string): Promise<OrganizerIdentification | null> {
  const v = await db.organizerVerification.findFirst({
    where: { organizationId, status: "APPROVED" },
    orderBy: { createdAt: "desc" },
    select: { legalType: true, legalName: true, documentType: true, documentLast4: true },
  });
  if (!v) return null;
  return { legalType: v.legalType, legalName: v.legalName, cnpjLast4: v.documentType === "CNPJ" ? v.documentLast4 : null };
}

// ───────────────────────────── Descoberta ─────────────────────────────

/**
 * Eventos relacionados na página do evento: futuros e públicos, primeiro da mesma
 * categoria na mesma cidade, depois da mesma categoria e por fim da mesma cidade.
 */
export async function relatedEvents(db: Db, event: { id: string; categoryId: string; cityId: string | null }, limit = 4, now = new Date()) {
  const base: Prisma.EventWhereInput = { ...publicEventWhere(now), id: { not: event.id } };
  const sameCity: Prisma.EventWhereInput | null = event.cityId ? { OR: [{ cityId: event.cityId }, { venue: { cityId: event.cityId } }] } : null;
  const tiers: Prisma.EventWhereInput[] = [
    ...(sameCity ? [{ AND: [base, { categoryId: event.categoryId }, sameCity] }] : []),
    { AND: [base, { categoryId: event.categoryId }] },
    ...(sameCity ? [{ AND: [base, sameCity] }] : []),
  ];
  const picked: CardRow[] = [];
  for (const where of tiers) {
    if (picked.length >= limit) break;
    const rows = await db.event.findMany({
      where: { AND: [where, { id: { notIn: picked.map((p) => p.id) } }] },
      select: cardSelect,
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: limit - picked.length,
    });
    picked.push(...rows);
  }
  return toCards(db, picked, now);
}

/** Eventos já realizados de um organizador (perfil público), mais recentes primeiro. */
export async function pastOrganizerEvents(db: Db, organizationId: string, limit = 12, now = new Date()) {
  const rows = await db.event.findMany({
    where: { organizationId, status: { in: ["PUBLISHED", "COMPLETED"] }, endsAt: { lte: now }, organization: { status: "APPROVED" } },
    select: cardSelect,
    orderBy: [{ startsAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return toCards(db, rows, now);
}

/** Organizadores em destaque na home: aprovados com mais eventos futuros no ar. */
export async function featuredOrganizers(db: Db, limit = 6, now = new Date()) {
  const rows = await db.organization.findMany({
    where: { status: "APPROVED", events: { some: publicEventWhere(now) } },
    select: { id: true, name: true, slug: true, logoUrl: true, city: true, _count: { select: { events: { where: publicEventWhere(now) } } } },
    take: 50,
  });
  return rows
    .map(({ _count, ...o }) => ({ ...o, upcoming: _count.events }))
    .sort((a, b) => b.upcoming - a.upcoming || a.name.localeCompare(b.name, "pt-BR"))
    .slice(0, limit);
}

/**
 * Recomendações para quem já comprou: eventos futuros das categorias (e, depois, das
 * cidades) dos pedidos pagos, sem os eventos que a pessoa já tem. Sem histórico: vazio.
 */
export async function recommendedEvents(db: Db, userId: string, limit = 4, now = new Date()) {
  const past = await db.order.findMany({
    where: { userId, status: { in: ["PAID", "REFUNDED"] } },
    select: { eventId: true, event: { select: { categoryId: true, cityId: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (!past.length) return [];
  const seen = [...new Set(past.map((o) => o.eventId))];
  const categories = [...new Set(past.map((o) => o.event.categoryId))];
  const cities = [...new Set(past.map((o) => o.event.cityId).filter((c): c is string => !!c))];
  const base: Prisma.EventWhereInput = { ...publicEventWhere(now), id: { notIn: seen } };
  const picked: CardRow[] = [];
  for (const where of [
    { AND: [base, { categoryId: { in: categories } }] },
    ...(cities.length ? [{ AND: [base, { OR: [{ cityId: { in: cities } }, { venue: { cityId: { in: cities } } }] }] }] : []),
  ] satisfies Prisma.EventWhereInput[]) {
    if (picked.length >= limit) break;
    picked.push(
      ...(await db.event.findMany({
        where: { AND: [where, { id: { notIn: picked.map((p) => p.id) } }] },
        select: cardSelect,
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        take: limit - picked.length,
      })),
    );
  }
  return toCards(db, picked, now);
}

/** Panorama de /cidades: cidades com evento no ar e quantos eventos nativos futuros há em cada uma. */
export async function cityOverview(db: Db, now = new Date()) {
  const [cities, events] = await Promise.all([
    listCities(db, { now }),
    db.event.findMany({ where: publicEventWhere(now), select: { cityId: true, venue: { select: { cityId: true } } } }),
  ]);
  const counts = new Map<string, number>();
  for (const e of events) {
    const id = e.venue?.cityId ?? e.cityId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return cities.map((c) => ({ id: c.id, slug: c.slug, name: c.name, state: c.state, isFeatured: c.isFeatured, events: counts.get(c.id) ?? 0 }));
}

export async function getPublicOrganizer(db: Db, slug: string, now = new Date()) {
  const org = await db.organization.findFirst({
    where: { slug, status: "APPROVED" },
    select: { id: true, name: true, slug: true, description: true, websiteUrl: true, instagramHandle: true, logoUrl: true, coverUrl: true, city: true, createdAt: true },
  });
  if (!org) return null;
  const rows = await db.event.findMany({ where: { ...publicEventWhere(now), organizationId: org.id }, select: cardSelect, orderBy: { startsAt: "asc" } });
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

// Entradas para o sitemap: apenas o que é público e indexável.
export async function listSitemapEntries(db: Db, now = new Date()) {
  const [events, cities, organizers] = await Promise.all([
    db.event.findMany({ where: publicEventWhere(now), select: { slug: true, updatedAt: true }, orderBy: { startsAt: "asc" } }),
    // Só cidades com evento público: páginas vazias não entram no índice (a base do IBGE tem milhares).
    db.city.findMany({
      where: cityWithPublicEventsWhere(now),
      select: { slug: true },
      orderBy: { slug: "asc" },
    }),
    db.organization.findMany({ where: { status: "APPROVED" }, select: { slug: true, updatedAt: true }, orderBy: { slug: "asc" } }),
  ]);
  return { events, cities, organizers };
}
