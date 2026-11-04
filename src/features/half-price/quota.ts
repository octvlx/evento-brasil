// Reserva automática da cota legal de meia-entrada (L7c): cálculo puro, sem
// Prisma. O mesmo estado alimenta createOrder (garantia final, sob a trava do
// evento), o pagamento tardio, o painel do organizador e a página pública.
//
// Classificação dos tipos:
// - meia: kind HALF_PRICE (oculta ou não; o uso conta sempre);
// - elegível: meia OU tipo público pago (inteira, VIP, promocional, lote);
// - não elegível: oculto pago ou gratuito (cortesia, convite). Consome
//   capacidade, mas não entra na base da cota.
//
// `quantitySold` é monotônico (inclui reembolsados): reembolso não devolve cota
// nem estoque. Reservas pendentes contam como comprometidas até serem liberadas.
import { HALF_PRICE_POLICY, deadlineHoursFor, quotaOf } from "./policy";

export type HalfPriceRegimeValue = "FEDERAL" | "NOT_SUBJECT";

export interface HalfPriceEventInput {
  capacity: number;
  startsAt: Date;
  /** Limite de meia oferecido (bps do estoque elegível). Nulo = sem limite; abaixo de 40% vale 40%. */
  halfPriceQuotaBps: number | null;
  halfPriceRegime: HalfPriceRegimeValue;
  /** Capacidade do local físico; nulo se online ou sem capacidade cadastrada. */
  venueCapacity: number | null;
}

export interface HalfPriceTypeInput {
  id: string;
  kind: string;
  priceCents: number;
  isHidden: boolean;
  quantityTotal: number;
  quantityReserved: number;
  quantitySold: number;
}

export type HalfPriceStatus = "NOT_APPLICABLE" | "EXHAUSTED" | "RESERVED" | "RELEASED";
export type HalfPriceNotApplicableReason = "NOT_SUBJECT" | "NO_HALF_PRICE_TYPE" | "NO_ELIGIBLE_STOCK";
export type HalfPriceWarning = "HALF_STOCK_BELOW_QUOTA" | "CONFIGURED_BPS_BELOW_LEGAL";
export type HalfPriceRequestError = "HALF_QUOTA_EXHAUSTED" | "RESERVED_FOR_HALF_PRICE";
export type TicketUnavailableReason = "SOLD_OUT" | HalfPriceRequestError;

export interface HalfPriceState {
  physicalCapacity: number | null;
  eventCapacity: number;
  deadlineHours: number;
  releaseAt: Date;
  /** Σ (reservado + vendido) dos tipos não elegíveis. */
  nonEligibleCommitted: number;
  /** E: estoque elegível (base da cota). */
  eligibleStock: number;
  /** Q: cota protegida (40% de E). */
  quota: number;
  /** L: limite de meia oferecido (≥ Q). `Infinity` se o evento não definiu limite. */
  halfLimit: number;
  halfSold: number;
  halfReserved: number;
  halfCommitted: number;
  fullSold: number;
  fullReserved: number;
  fullCommitted: number;
  applicable: boolean;
  notApplicableReason: HalfPriceNotApplicableReason | null;
  reserveActive: boolean;
  /** Saldo da cota: Q − meias comprometidas (0 se não aplicável). */
  balance: number;
  /** Ingressos indisponíveis para inteira por causa da reserva. */
  blocked: number;
  status: HalfPriceStatus;
  capacityLeft: number;
  fullAvailable: number;
  halfAvailable: number;
  nonEligibleAvailable: number;
  halfUnavailableReason: "QUOTA_EXHAUSTED" | "SOLD_OUT" | null;
  /** Inteiras já dentro da cota protegida (ex.: data adiada): barram novas vendas não-meia. */
  violation: number;
  warnings: HalfPriceWarning[];
}

const isHalf = (t: Pick<HalfPriceTypeInput, "kind">) => t.kind === "HALF_PRICE";
const isEligible = (t: HalfPriceTypeInput) => isHalf(t) || (!t.isHidden && t.priceCents > 0);
const committedOf = (t: HalfPriceTypeInput) => t.quantityReserved + t.quantitySold;
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);
const pos = (n: number) => Math.max(0, n);

export function releaseAtOf(event: Pick<HalfPriceEventInput, "startsAt" | "capacity" | "venueCapacity">): { deadlineHours: number; releaseAt: Date } {
  const deadlineHours = deadlineHoursFor(event.venueCapacity ?? event.capacity);
  return { deadlineHours, releaseAt: new Date(event.startsAt.getTime() - deadlineHours * 3_600_000) };
}

/** Parte do estado que não depende do quanto de não elegível ainda será vendido. */
function core(event: HalfPriceEventInput, types: HalfPriceTypeInput[], now: Date) {
  const { deadlineHours, releaseAt } = releaseAtOf(event);
  const eligible = types.filter(isEligible);
  const half = eligible.filter(isHalf);
  const full = eligible.filter((t) => !isHalf(t));
  const nonEligibleCommitted = sum(types.filter((t) => !isEligible(t)), committedOf);
  const eligibleStock = pos(Math.min(event.capacity - nonEligibleCommitted, sum(eligible, (t) => t.quantityTotal)));
  const quota = quotaOf(eligibleStock, HALF_PRICE_POLICY.quotaBps);
  const halfLimit =
    event.halfPriceQuotaBps === null ? Infinity : quotaOf(eligibleStock, Math.max(event.halfPriceQuotaBps, HALF_PRICE_POLICY.quotaBps));
  const halfSold = sum(half, (t) => t.quantitySold);
  const halfReserved = sum(half, (t) => t.quantityReserved);
  const fullSold = sum(full, (t) => t.quantitySold);
  const fullReserved = sum(full, (t) => t.quantityReserved);
  const notApplicableReason: HalfPriceNotApplicableReason | null =
    event.halfPriceRegime === "NOT_SUBJECT"
      ? "NOT_SUBJECT"
      : !half.some((t) => !t.isHidden)
        ? "NO_HALF_PRICE_TYPE"
        : eligibleStock === 0
          ? "NO_ELIGIBLE_STOCK"
          : null;
  const applicable = notApplicableReason === null;
  const reserveActive = applicable && now.getTime() < releaseAt.getTime();
  const halfCommitted = halfSold + halfReserved;
  const fullCommitted = fullSold + fullReserved;
  const balance = applicable ? pos(quota - halfCommitted) : 0;
  const violation = reserveActive ? pos(fullCommitted + halfCommitted + balance - eligibleStock) : 0;
  return {
    deadlineHours, releaseAt, half, nonEligibleCommitted, eligibleStock, quota, halfLimit,
    halfSold, halfReserved, halfCommitted, fullSold, fullReserved, fullCommitted,
    applicable, notApplicableReason, reserveActive, balance, violation,
  };
}

export function computeHalfPriceState(event: HalfPriceEventInput, types: HalfPriceTypeInput[], now: Date): HalfPriceState {
  const c = core(event, types, now);
  const blocked = c.reserveActive ? c.balance : 0;
  const capacityLeft = pos(event.capacity - sum(types, committedOf));
  const eligibleLeft = c.eligibleStock - c.fullCommitted - c.halfCommitted;
  const fullAvailable = pos(Math.min(capacityLeft - blocked, eligibleLeft - blocked));
  const halfStockLeft = sum(c.half.filter((t) => !t.isHidden), (t) => t.quantityTotal - committedOf(t));
  const halfAvailable = pos(Math.min(capacityLeft, c.halfLimit - c.halfCommitted, eligibleLeft, halfStockLeft));
  const status: HalfPriceStatus = !c.applicable ? "NOT_APPLICABLE" : c.halfCommitted >= c.quota ? "EXHAUSTED" : c.reserveActive ? "RESERVED" : "RELEASED";
  const warnings: HalfPriceWarning[] = [];
  if (c.applicable && sum(c.half, (t) => t.quantityTotal) < c.quota) warnings.push("HALF_STOCK_BELOW_QUOTA");
  if (event.halfPriceQuotaBps !== null && event.halfPriceQuotaBps < HALF_PRICE_POLICY.quotaBps) warnings.push("CONFIGURED_BPS_BELOW_LEGAL");
  return {
    physicalCapacity: event.venueCapacity,
    eventCapacity: event.capacity,
    deadlineHours: c.deadlineHours,
    releaseAt: c.releaseAt,
    nonEligibleCommitted: c.nonEligibleCommitted,
    eligibleStock: c.eligibleStock,
    quota: c.quota,
    halfLimit: c.halfLimit,
    halfSold: c.halfSold,
    halfReserved: c.halfReserved,
    halfCommitted: c.halfCommitted,
    fullSold: c.fullSold,
    fullReserved: c.fullReserved,
    fullCommitted: c.fullCommitted,
    applicable: c.applicable,
    notApplicableReason: c.notApplicableReason,
    reserveActive: c.reserveActive,
    balance: c.balance,
    blocked,
    status,
    capacityLeft,
    fullAvailable,
    halfAvailable,
    nonEligibleAvailable: nonEligibleAvailable(event, types, now, capacityLeft, c.violation),
    halfUnavailableReason: c.halfLimit - c.halfCommitted <= 0 ? "QUOTA_EXHAUSTED" : halfAvailable === 0 ? "SOLD_OUT" : null,
    violation: c.violation,
    warnings,
  };
}

/**
 * Maior quantidade de não elegíveis (ex.: gratuito público) que `checkHalfPriceRequest`
 * aceitaria agora. Um não elegível reduz a base E (e com ela a cota), então o valor
 * exato não é `capacityLeft − blocked`: busca binária sobre a mesma regra do pedido
 * (a violação é monótona na quantidade), para a página mostrar o que o pedido aceita.
 */
function nonEligibleAvailable(event: HalfPriceEventInput, types: HalfPriceTypeInput[], now: Date, capacityLeft: number, violation: number): number {
  if (violation > 0) return 0;
  const probe: HalfPriceTypeInput = { id: "\0probe", kind: "FREE", priceCents: 0, isHidden: false, quantityTotal: 0, quantityReserved: 0, quantitySold: 0 };
  const fits = (k: number) => core(event, [...types, { ...probe, quantityReserved: k }], now).violation === 0;
  let lo = 0;
  let hi = capacityLeft;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface HalfPriceRequestItem {
  ticketTypeId: string;
  quantity: number;
}

/**
 * Simula o pedido (as quantidades entram como reservadas) e diz se a regra da meia o barra.
 * Não confere estoque por tipo, capacidade nem limites por pedido (createOrder confere).
 * Meia nunca é barrada pela violação da reserva — só pelo limite de meia (L).
 */
export function checkHalfPriceRequest(
  event: HalfPriceEventInput,
  types: HalfPriceTypeInput[],
  requested: HalfPriceRequestItem[],
  now: Date,
): HalfPriceRequestError | null {
  const qty = new Map<string, number>();
  for (const r of requested) if (r.quantity > 0) qty.set(r.ticketTypeId, (qty.get(r.ticketTypeId) ?? 0) + r.quantity);
  const asked = types.filter((t) => qty.has(t.id));
  if (!asked.length) return null;
  const after = types.map((t) => (qty.has(t.id) ? { ...t, quantityReserved: t.quantityReserved + qty.get(t.id)! } : t));
  const c = core(event, after, now);
  if (asked.some(isHalf) && c.halfCommitted > c.halfLimit) return "HALF_QUOTA_EXHAUSTED";
  if (asked.some((t) => !isHalf(t)) && c.violation > 0) return "RESERVED_FOR_HALF_PRICE";
  return null;
}

/**
 * Guarda de mudança de estoque/capacidade/tipos (organizador). Compare estados com a
 * MESMA data e local; mudança só de data nunca é barrada (é auditada).
 */
export function stockChangeError(before: HalfPriceState, after: HalfPriceState): string | null {
  if (after.violation <= before.violation) return null;
  const n = after.violation;
  return (
    `Esta alteração invadiria a reserva legal de meia-entrada (40% do estoque elegível até ${after.deadlineHours} h antes do início): ` +
    `faltariam ${n} ${n === 1 ? "ingresso" : "ingressos"} para a cota.`
  );
}

/**
 * Disponível por tipo público, com o motivo quando é 0. Mesma regra de createOrder
 * (estoque do tipo, capacidade e reserva da meia), para a página e o checkout mostrarem
 * o que o pedido aceita. Expirados ainda não liberados contam como reservados (conservador).
 */
export function ticketAvailability(state: HalfPriceState, types: HalfPriceTypeInput[]): Map<string, { available: number; reason: TicketUnavailableReason | null }> {
  const out = new Map<string, { available: number; reason: TicketUnavailableReason | null }>();
  for (const t of types) {
    if (t.isHidden) continue;
    const stock = Math.min(pos(t.quantityTotal - committedOf(t)), state.capacityLeft);
    if (stock === 0) {
      out.set(t.id, { available: 0, reason: "SOLD_OUT" });
      continue;
    }
    if (isHalf(t)) {
      const available = Math.min(stock, state.halfAvailable);
      out.set(t.id, { available, reason: available ? null : state.halfUnavailableReason === "QUOTA_EXHAUSTED" ? "HALF_QUOTA_EXHAUSTED" : "SOLD_OUT" });
      continue;
    }
    const cap = isEligible(t) ? state.fullAvailable : state.nonEligibleAvailable;
    const available = Math.min(stock, cap);
    // Barrado pela reserva: sem ela haveria ingresso (blocked > 0 ou inteiras já dentro da cota).
    const byReserve = state.reserveActive && (state.blocked > 0 || state.violation > 0);
    out.set(t.id, { available, reason: available ? null : byReserve ? "RESERVED_FOR_HALF_PRICE" : "SOLD_OUT" });
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "20/11/2026 às 18:00" no fuso do evento. */
export function formatReleaseAt(releaseAt: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(releaseAt)
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute", number>;
  return `${pad(p.day)}/${pad(p.month)}/${p.year} às ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Mensagem pt-BR para o comprador (mesma em createOrder, checkout e página). */
export function halfPriceRequestMessage(code: HalfPriceRequestError, releaseAt: Date, timeZone: string): string {
  return code === "HALF_QUOTA_EXHAUSTED"
    ? "Cota de meia-entrada esgotada."
    : `Os ingressos restantes estão reservados para meia-entrada até ${formatReleaseAt(releaseAt, timeZone)}.`;
}
