// Reserva de estoque e criação de pedidos.
//
// Ordem de travas (evita deadlock): sempre Event → Order → Coupon.
// Toda mutação de contadores de TicketType ocorre com a linha do Event
// travada (SELECT … FOR UPDATE), e CHECKs no banco impedem overselling
// mesmo que uma regra aqui falhe.
//
// Cupons (ADR 0002, D4) são trava-folha: um cupom de organização é
// compartilhado entre eventos, então uma transação que mexe em mais de um
// cupom trava TODOS de uma vez, em ordem de id (`lockCoupons`), antes de
// alterar qualquer contador — e nunca trava Event/Order depois de um cupom.
import "server-only";
import type { OrderStatus } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { createOrderSchema, type CreateOrderInput } from "@/features/schemas";
import { discountPerUnit, undercutHalfPrice } from "@/features/fees/discount";
import { computeFees, lineWithNegativePayout } from "@/features/fees/policy";
import { onlyDigits } from "@/lib/br";
import { hasEventEnded } from "@/lib/event-lifecycle";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { assertActive, type Actor } from "../auth/permissions";
import { randomCode } from "../crypto";
import { env } from "../env";
import { rateLimit } from "../rate-limit";
import { AppError, forbidden, invalidState, notFound } from "../errors";
import { resolveCommissionRule } from "./commission";
import { postSale } from "./ledger";
import { notifyOrderPaid } from "./notifications";
import { issueTicketsTx } from "./tickets";

export async function lockEvent(tx: Tx, eventId: string) {
  await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
}

export async function lockOrder(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
}

/** Trava os cupons em uma única instrução, em ordem de id (ver cabeçalho). */
export async function lockCoupons(tx: Tx, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))].sort();
  if (!unique.length) return;
  await tx.$queryRaw`SELECT id FROM "Coupon" WHERE id IN (${Prisma.join(unique)}) ORDER BY id FOR UPDATE`;
}

/** Trava os cupons de um conjunto de pedidos (antes de liberar vários de uma vez). */
export async function lockCouponsOfOrders(tx: Tx, where: Prisma.OrderWhereInput, extra: (string | null | undefined)[] = []) {
  const rows = await tx.order.findMany({ where: { AND: [where, { couponId: { not: null } }] }, select: { couponId: true }, distinct: ["couponId"] });
  await lockCoupons(tx, [...rows.map((r) => r.couponId), ...extra]);
}

/**
 * Libera as reservas de um pedido pendente. Pré-condição: trava do evento.
 * Retorna false se o pedido não estava mais pendente (idempotente).
 */
export async function releaseOrderTx(
  tx: Tx,
  orderId: string,
  status: Extract<OrderStatus, "EXPIRED" | "CANCELLED" | "PAYMENT_FAILED">,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  const { count } = await tx.order.updateMany({ where: { id: orderId, status: "PENDING_PAYMENT" }, data: { status, cancelledAt: now } });
  if (!count) return false;
  const { couponId } = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { couponId: true } });
  if (couponId) await tx.coupon.update({ where: { id: couponId }, data: { timesReserved: { decrement: 1 } } });
  const reservations = await tx.ticketInventoryReservation.findMany({ where: { orderId, status: "ACTIVE" } });
  for (const r of reservations) {
    await tx.ticketType.update({ where: { id: r.ticketTypeId }, data: { quantityReserved: { decrement: r.quantity } } });
  }
  await tx.ticketInventoryReservation.updateMany({
    where: { orderId, status: "ACTIVE" },
    data: { status: "RELEASED", releasedAt: now, releaseReason: reason },
  });
  return true;
}

async function releaseExpiredForEventTx(tx: Tx, eventId: string, now: Date) {
  const where = { eventId, status: "PENDING_PAYMENT", expiresAt: { lte: now } } satisfies Prisma.OrderWhereInput;
  await lockCouponsOfOrders(tx, where);
  const stale = await tx.order.findMany({ where, select: { id: true } });
  for (const o of stale) await releaseOrderTx(tx, o.id, "EXPIRED", "reservation_expired", now);
  return stale.length;
}

/** Job periódico: expira reservas vencidas em todos os eventos. */
export async function expireStaleOrders(db: Db, now = new Date()): Promise<number> {
  const stale = await db.order.findMany({
    where: { status: "PENDING_PAYMENT", expiresAt: { lte: now } },
    select: { eventId: true },
    distinct: ["eventId"],
    take: 500,
  });
  let released = 0;
  for (const { eventId } of stale) {
    released += await db.$transaction(async (tx) => {
      await lockEvent(tx, eventId);
      return releaseExpiredForEventTx(tx, eventId, now);
    }, TX_OPTIONS);
  }
  return released;
}

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

/**
 * Converte reservas em vendidos, emite ingressos e marca o pedido como pago.
 * Pré-condições: trava do evento e do pedido; pagamento verificado (ou pedido gratuito).
 */
export async function finalizePaidOrderTx(tx: Tx, order: OrderWithItems, now = new Date()) {
  if (order.status !== "PENDING_PAYMENT") throw invalidState(`Pedido ${order.publicCode} não está pendente.`);
  const reservations = await tx.ticketInventoryReservation.findMany({ where: { orderId: order.id, status: "ACTIVE" } });
  for (const r of reservations) {
    await tx.ticketType.update({
      where: { id: r.ticketTypeId },
      data: { quantityReserved: { decrement: r.quantity }, quantitySold: { increment: r.quantity } },
    });
  }
  await tx.ticketInventoryReservation.updateMany({ where: { orderId: order.id, status: "ACTIVE" }, data: { status: "CONVERTED" } });
  await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: now } });
  // Uso do cupom: reservado → resgatado (único ponto, inclusive para pedido gratuito).
  if (order.couponId) await tx.coupon.update({ where: { id: order.couponId }, data: { timesReserved: { decrement: 1 }, timesRedeemed: { increment: 1 } } });
  await issueTicketsTx(tx, order);
}

/**
 * Pagamento confirmado após a reserva expirar: tenta recuperar estoque.
 * Pré-condição: trava do evento. Retorna false se não há mais disponibilidade
 * ou se o evento já terminou (pelo relógio, com ou sem o job ter rodado).
 */
export async function acquireLateInventoryTx(tx: Tx, order: OrderWithItems, now = new Date()): Promise<boolean> {
  const event = await tx.event.findUniqueOrThrow({ where: { id: order.eventId }, include: { ticketTypes: true } });
  if (event.status !== "PUBLISHED" || hasEventEnded(event, now)) return false;
  const byId = new Map(event.ticketTypes.map((t) => [t.id, t]));
  const committed = event.ticketTypes.reduce((s, t) => s + t.quantityReserved + t.quantitySold, 0);
  const requested = order.items.reduce((s, i) => s + i.quantity, 0);
  if (committed + requested > event.capacity) return false;
  for (const item of order.items) {
    const t = byId.get(item.ticketTypeId);
    if (!t || t.quantityTotal - t.quantityReserved - t.quantitySold < item.quantity) return false;
  }
  for (const item of order.items) {
    await tx.ticketType.update({ where: { id: item.ticketTypeId }, data: { quantitySold: { increment: item.quantity } } });
  }
  await tx.order.update({ where: { id: order.id }, data: { status: "PAID", paidAt: now } });
  if (order.couponId) {
    // A reserva do uso já foi liberada na expiração. O comprador pagou o preço
    // com desconto: o uso é honrado mesmo acima do limite, e fica auditado (D4).
    const c = await tx.coupon.update({ where: { id: order.couponId }, data: { timesRedeemed: { increment: 1 } } });
    if (c.maxUses !== null && c.timesReserved + c.timesRedeemed > c.maxUses) {
      await audit(tx, {
        organizationId: order.organizationId,
        action: "coupon.redeemed_over_limit",
        entityType: "Coupon",
        entityId: c.id,
        metadata: { orderId: order.id, maxUses: c.maxUses, timesReserved: c.timesReserved, timesRedeemed: c.timesRedeemed },
      });
    }
  }
  await issueTicketsTx(tx, order);
  return true;
}

// ───────────────────────────── Cupom e atribuição (ADR 0002) ─────────────────────────────

const COUPON_CODE = /^[A-Z0-9_-]{3,32}$/;
const COUPON_ATTEMPTS_PER_WINDOW = 10;
const COUPON_ATTEMPT_WINDOW_MS = 10 * 60_000;

/** Mesma mensagem para inexistente, de outra organização/evento ou desativado (não revelar qual). */
const couponUnavailable = () => new AppError("VALIDATION", "Cupom inválido ou indisponível.");

type CouponWithTypes = Prisma.CouponGetPayload<{ include: { ticketTypes: { select: { ticketTypeId: true } } } }>;

/** Pré-condição: cupom travado (lockCoupons). */
async function validateCouponTx(tx: Tx, couponId: string, userId: string, eventId: string, now: Date): Promise<CouponWithTypes> {
  const c = await tx.coupon.findUniqueOrThrow({ where: { id: couponId }, include: { ticketTypes: { select: { ticketTypeId: true } } } });
  if (c.disabledAt || (c.eventId && c.eventId !== eventId)) throw couponUnavailable();
  if ((c.validFrom && now < c.validFrom) || (c.validUntil && now >= c.validUntil)) throw new AppError("VALIDATION", "Cupom fora do período de validade.");
  if (c.maxUses !== null && c.timesReserved + c.timesRedeemed >= c.maxUses) throw new AppError("SOLD_OUT", "Cupom esgotado.");
  if (c.maxUsesPerUser !== null) {
    // Mesma definição dos contadores: pendente ou com ingressos emitidos (reembolso não devolve o uso).
    const used = await tx.order.count({ where: { couponId: c.id, userId, OR: [{ status: "PENDING_PAYMENT" }, { tickets: { some: {} } }] } });
    if (used >= c.maxUsesPerUser) throw new AppError("LIMIT_EXCEEDED", "Você já usou este cupom o número máximo de vezes.");
  }
  return c;
}

type PricedType = { id: string; kind: string; priceCents: number; isHidden: boolean };

/**
 * Desconto por tipo de ingresso do pedido. Não se aplica a gratuitos nem a
 * meia-entrada (padrão até a revisão jurídica, D3); sem tipos no cupom = todos
 * os pagos do evento. Recusa se nenhum item recebe desconto ou se a inteira
 * com desconto ficaria mais barata que a meia-entrada.
 */
function couponDiscounts(c: CouponWithTypes, requested: PricedType[], eventTypes: PricedType[]) {
  const restricted = new Set(c.ticketTypes.map((t) => t.ticketTypeId));
  const halfPrices = eventTypes.filter((t) => t.kind === "HALF_PRICE" && !t.isHidden).map((t) => t.priceCents);
  const out = new Map<string, number>();
  for (const t of requested) {
    if (t.kind === "HALF_PRICE" || t.priceCents === 0) continue;
    if (restricted.size && !restricted.has(t.id)) continue;
    const d = discountPerUnit(t.priceCents, c);
    if (!d) continue;
    if (undercutHalfPrice(t.priceCents, t.priceCents - d, halfPrices) !== undefined)
      throw new AppError("VALIDATION", "Com este cupom a inteira ficaria mais barata que a meia-entrada; não é possível aplicá-lo.");
    out.set(t.id, d);
  }
  if (!out.size) throw new AppError("VALIDATION", "Este cupom não vale para os ingressos selecionados.");
  return out;
}

const UTM_MAX = 200;
const cutUtm = (v: string | undefined) => v?.trim().slice(0, UTM_MAX) || null;

/**
 * Instantâneo da origem da venda. Link de outro evento (ou inexistente) é
 * descartado junto com os UTMs que vieram com ele; sem link, UTMs soltos
 * valem. Com link e sem UTMs, usa os do link.
 */
async function resolveAttributionTx(tx: Tx, eventId: string, a: CreateOrderInput["attribution"]) {
  const empty = { trackingLinkId: null, utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null };
  if (!a) return empty;
  const utm = {
    utmSource: cutUtm(a.utmSource),
    utmMedium: cutUtm(a.utmMedium),
    utmCampaign: cutUtm(a.utmCampaign),
    utmContent: cutUtm(a.utmContent),
    utmTerm: cutUtm(a.utmTerm),
  };
  if (!a.trackingLinkId) return { ...empty, ...utm };
  const link = await tx.trackingLink.findUnique({ where: { id: a.trackingLinkId } });
  if (!link || link.eventId !== eventId) return empty;
  const fromLink = { utmSource: link.utmSource, utmMedium: link.utmMedium, utmCampaign: link.utmCampaign, utmContent: link.utmContent, utmTerm: link.utmTerm };
  return { trackingLinkId: link.id, ...(Object.values(utm).some(Boolean) ? utm : fromLink) };
}

/**
 * Ingressos de um evento que contam para o limite por conta (R4,
 * `Event.maxTicketsPerAccount`): os ingressos VALID/CHECKED_IN de que a conta é
 * titular (`holderUserId`, inclusive recebidos por transferência) mais as
 * quantidades dos pedidos PENDING_PAYMENT da conta nesse evento.
 *
 * Contrato com `check-in` (aceite de transferência). Para o resultado valer na
 * decisão, chame com a trava do evento (`lockEvent`) já tomada: é a mesma trava
 * que serializa `createOrder`.
 */
export async function ticketsHeldByAccount(client: Db | Tx, userId: string, eventId: string, now = new Date()): Promise<number> {
  const [held, pending] = await Promise.all([
    client.issuedTicket.count({ where: { eventId, holderUserId: userId, status: { in: ["VALID", "CHECKED_IN"] } } }),
    // Reserva vencida ainda não liberada pela manutenção não conta.
    client.orderItem.aggregate({ where: { order: { eventId, userId, status: "PENDING_PAYMENT", expiresAt: { gt: now } } }, _sum: { quantity: true } }),
  ]);
  return held + (pending._sum.quantity ?? 0);
}

const ticketsWord = (n: number) => `${n} ${n === 1 ? "ingresso" : "ingressos"}`;

export interface CreateOrderOptions {
  /** Internal checkout orchestration only: keeps free tickets pending until review. */
  checkoutReviewRequired?: boolean;
  /** Reuse the caller transaction to serialize draft/order creation atomically. */
  transaction?: Tx;
  now?: Date;
  /** O provedor configurado é o simulado (marca o pedido como simulado). */
  providerIsSimulated: boolean;
  providerId?: string;
  /** False quando o adaptador ainda não oferece nenhum método de pagamento. */
  paymentsAvailable?: boolean;
}

export async function createOrder(db: Db, actor: Actor, raw: CreateOrderInput, opts: CreateOrderOptions) {
  assertActive(actor);
  const input = createOrderSchema.parse(raw);
  const now = opts.now ?? new Date();

  const client = opts.transaction ?? db;
  const existing = await client.order.findUnique({ where: { userId_idempotencyKey: { userId: actor.id, idempotencyKey: input.idempotencyKey } } });
  if (existing) return existing;

  const merged = new Map<string, (typeof input.items)[number]>();
  for (const item of input.items) {
    if (merged.has(item.ticketTypeId)) throw new AppError("VALIDATION", "Tipo de ingresso repetido no pedido.");
    merged.set(item.ticketTypeId, item);
  }

  const couponCode = input.couponCode?.trim().toUpperCase() || null;
  // Contra força bruta de códigos: conta toda tentativa com cupom.
  if (couponCode) await rateLimit(`coupon:${actor.id}`, COUPON_ATTEMPTS_PER_WINDOW, COUPON_ATTEMPT_WINDOW_MS, db);

  try {
    const create = async (tx: Tx) => {
      await lockEvent(tx, input.eventId);
      const event = await tx.event.findUnique({
        where: { id: input.eventId },
        include: {
          organization: {
            include: { mercadoPagoAccount: { select: { revokedAt: true } } },
          },
        },
      });
      if (!event || event.status !== "PUBLISHED") throw notFound("Evento indisponível.");
      if (event.organization.status !== "APPROVED") throw new AppError("SALES_CLOSED", "Vendas indisponíveis para este organizador.");
      if (now < event.salesStartAt) throw new AppError("SALES_CLOSED", "As vendas ainda não começaram.");
      if (now >= event.salesEndAt || now >= event.endsAt) throw new AppError("SALES_CLOSED", "As vendas deste evento foram encerradas.");

      // Cupom: trava, numa só instrução, o cupom pedido e os dos pedidos que esta
      // transação vai liberar (vencidos do evento e o pendente anterior do comprador).
      const couponRef =
        couponCode && COUPON_CODE.test(couponCode)
          ? await tx.coupon.findUnique({ where: { organizationId_code: { organizationId: event.organizationId, code: couponCode } }, select: { id: true } })
          : null;
      if (couponCode && !couponRef) throw couponUnavailable();
      await lockCouponsOfOrders(tx, { eventId: event.id, status: "PENDING_PAYMENT", OR: [{ expiresAt: { lte: now } }, { userId: actor.id }] }, [couponRef?.id]);

      await releaseExpiredForEventTx(tx, event.id, now);
      // Um pedido pendente por usuário/evento: o anterior é liberado.
      const previous = await tx.order.findMany({ where: { userId: actor.id, eventId: event.id, status: "PENDING_PAYMENT" }, select: { id: true } });
      for (const p of previous) await releaseOrderTx(tx, p.id, "CANCELLED", "replaced_by_new_order", now);

      const ticketTypes = await tx.ticketType.findMany({ where: { eventId: event.id } });
      const byId = new Map(ticketTypes.map((t) => [t.id, t]));
      let requested = 0;
      let halfRequested = 0;
      for (const item of merged.values()) {
        const t = byId.get(item.ticketTypeId);
        if (!t || t.isHidden) throw new AppError("VALIDATION", "Tipo de ingresso inválido para este evento.");
        if ((t.salesStartAt && now < t.salesStartAt) || (t.salesEndAt && now >= t.salesEndAt))
          throw new AppError("SALES_CLOSED", `Vendas de "${t.name}" fora do período.`);
        if (item.quantity < t.minPerOrder || item.quantity > t.maxPerOrder)
          throw new AppError("LIMIT_EXCEEDED", `"${t.name}": de ${t.minPerOrder} a ${t.maxPerOrder} por pedido.`);
        if (t.quantityTotal - t.quantityReserved - t.quantitySold < item.quantity)
          throw new AppError("SOLD_OUT", `Não há ingressos "${t.name}" suficientes disponíveis.`);
        if (t.requiresAttendeeInfo && item.attendees?.length !== item.quantity)
          throw new AppError("VALIDATION", `Informe os dados de cada participante de "${t.name}".`);
        requested += item.quantity;
        if (t.kind === "HALF_PRICE") halfRequested += item.quantity;
      }
      const committed = ticketTypes.reduce((s, t) => s + t.quantityReserved + t.quantitySold, 0);
      if (committed + requested > event.capacity) throw new AppError("SOLD_OUT", "Capacidade do evento esgotada.");
      // Limite por conta (R4). Sob a trava do evento e depois de liberar o pedido
      // pendente anterior do comprador, que seria substituído por este.
      if (event.maxTicketsPerAccount !== null) {
        const held = await ticketsHeldByAccount(tx, actor.id, event.id, now);
        if (held + requested > event.maxTicketsPerAccount) {
          const left = Math.max(0, event.maxTicketsPerAccount - held);
          throw new AppError(
            "LIMIT_EXCEEDED",
            `Este evento permite até ${ticketsWord(event.maxTicketsPerAccount)} por conta. ` +
              (held ? `Você já tem ${ticketsWord(held)}; ${left ? `pode comprar mais ${left}.` : "não é possível comprar mais."}` : "Reduza a quantidade."),
          );
        }
      }
      if (halfRequested > 0) {
        if (!input.halfPriceDeclaration) throw new AppError("VALIDATION", "Confirme a declaração de direito à meia-entrada.");
        if (event.halfPriceQuotaBps !== null) {
          const quota = Math.floor((event.capacity * event.halfPriceQuotaBps) / 10_000);
          const used = ticketTypes.filter((t) => t.kind === "HALF_PRICE").reduce((s, t) => s + t.quantityReserved + t.quantitySold, 0);
          if (used + halfRequested > quota) throw new AppError("SOLD_OUT", "Cota de meia-entrada esgotada.");
        }
      }

      // Desconto do cupom (validado com o cupom travado e o pedido anterior já liberado).
      const coupon = couponRef ? await validateCouponTx(tx, couponRef.id, actor.id, event.id, now) : null;
      const discounts = coupon ? couponDiscounts(coupon, [...merged.keys()].map((id) => byId.get(id)!), ticketTypes) : new Map<string, number>();

      // Preços SEMPRE do banco.
      const rule = await resolveCommissionRule(tx, event.organizationId, event.id, now);
      const fees = computeFees(
        [...merged.values()].map((i) => ({
          ticketTypeId: i.ticketTypeId,
          unitPriceCents: byId.get(i.ticketTypeId)!.priceCents,
          quantity: i.quantity,
          discountPerUnitCents: discounts.get(i.ticketTypeId) ?? 0,
          halfPrice: byId.get(i.ticketTypeId)!.kind === "HALF_PRICE",
        })),
        rule,
      );
      // Guarda B1 (ADR 0002): repasse negativo quebraria o razão na confirmação do pagamento.
      const negative = lineWithNegativePayout(fees, rule.bearer);
      if (negative?.discountPerUnitCents)
        throw new AppError("VALIDATION", "Desconto alto demais para este ingresso: o preço com desconto fica menor que a taxa da plataforma.");
      if (negative) throw new AppError("VALIDATION", "O preço deste ingresso é menor que a taxa da plataforma.");
      const attribution = await resolveAttributionTx(tx, event.id, input.attribution);
      const isFree = fees.totalCents === 0;
      if (!isFree && opts.paymentsAvailable === false)
        throw new AppError("SALES_CLOSED", "A compra de ingressos pagos está temporariamente indisponível.");
      const mercadoPagoConnected =
        event.organization.mercadoPagoAccount?.revokedAt === null;
      if (!isFree && opts.providerId === "mercadopago" && !mercadoPagoConnected)
        throw new AppError("SALES_CLOSED", "O organizador precisa conectar o Mercado Pago antes de vender ingressos pagos.");
      if (
        !isFree &&
        opts.providerId !== "mercadopago" &&
        !["CONNECTED", "SIMULATED"].includes(event.organization.paymentAccountStatus)
      )
        throw new AppError("SALES_CLOSED", "O organizador ainda não está habilitado para vender ingressos pagos.");
      if (!isFree && opts.providerId !== "mercadopago" && event.organization.paymentAccountStatus === "SIMULATED" && !opts.providerIsSimulated)
        throw new AppError("SALES_CLOSED", "Conta de recebimento do organizador não está conectada ao provedor real.");

      const expiresAt = new Date(now.getTime() + env().RESERVATION_MINUTES * 60_000);
      const order = await tx.order.create({
        data: {
          publicCode: `EB-${randomCode(8)}`,
          userId: actor.id,
          eventId: event.id,
          organizationId: event.organizationId,
          subtotalCents: fees.subtotalCents,
          serviceFeeCents: fees.serviceFeeCents,
          discountCents: fees.discountCents,
          couponId: coupon?.id ?? null,
          couponCode: coupon?.code ?? null,
          ...attribution,
          totalCents: fees.totalCents,
          commissionCents: fees.commissionCents,
          feePolicyVersion: fees.policyVersion,
          commissionRuleId: rule.id,
          buyerName: input.buyerName,
          buyerEmail: input.buyerEmail,
          buyerPhone: input.buyerPhone ? onlyDigits(input.buyerPhone) : null,
          idempotencyKey: input.idempotencyKey,
          checkoutReviewRequired: opts.checkoutReviewRequired ?? false,
          isSimulated: !isFree && opts.providerIsSimulated,
          expiresAt,
          items: {
            create: fees.lines.map((l) => {
              const t = byId.get(l.ticketTypeId)!;
              return {
                ticketTypeId: t.id,
                ticketTypeName: t.name,
                kind: t.kind,
                unitPriceCents: l.unitPriceCents,
                listUnitPriceCents: l.listUnitPriceCents,
                discountPerUnitCents: l.discountPerUnitCents,
                commissionPerUnitCents: l.commissionPerUnitCents,
                serviceFeePerUnitCents: l.serviceFeePerUnitCents,
                quantity: l.quantity,
                attendees: merged.get(t.id)!.attendees ?? Prisma.JsonNull,
              };
            }),
          },
          reservations: { create: fees.lines.map((l) => ({ ticketTypeId: l.ticketTypeId, quantity: l.quantity, expiresAt })) },
        },
        include: { items: true },
      });
      for (const l of fees.lines) {
        await tx.ticketType.update({ where: { id: l.ticketTypeId }, data: { quantityReserved: { increment: l.quantity } } });
      }
      // Uso do cupom reservado; vira resgatado em finalizePaidOrderTx (inclusive se gratuito).
      if (coupon) await tx.coupon.update({ where: { id: coupon.id }, data: { timesReserved: { increment: 1 } } });

      if (isFree && !opts.checkoutReviewRequired) {
        await tx.payment.create({
          data: { orderId: order.id, provider: "none", method: "FREE", status: "PAID", amountCents: 0, idempotencyKey: `free:${order.id}`, paidAt: now },
        });
        await finalizePaidOrderTx(tx, order, now);
        await postSale(tx, order, undefined);
      }
      await audit(tx, {
        actorUserId: actor.id,
        organizationId: event.organizationId,
        action: isFree && !opts.checkoutReviewRequired ? "order.free_issued" : "order.created",
        entityType: "Order",
        entityId: order.id,
        metadata: {
          totalCents: fees.totalCents,
          tickets: requested,
          ...(coupon ? { couponCode: coupon.code, discountCents: fees.discountCents } : {}),
          ...(attribution.trackingLinkId ? { trackingLinkId: attribution.trackingLinkId } : {}),
        },
      });
      return tx.order.findUniqueOrThrow({ where: { id: order.id } });
    };
    const created = opts.transaction ? await create(opts.transaction) : await db.$transaction(create, TX_OPTIONS);
    if (created.status === "PAID" && !opts.transaction) notifyOrderPaid(db, created.id);
    return created;
  } catch (err) {
    // Corrida na chave de idempotência: devolve o pedido já criado.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const again = await db.order.findUnique({ where: { userId_idempotencyKey: { userId: actor.id, idempotencyKey: input.idempotencyKey } } });
      if (again) return again;
    }
    throw err;
  }
}

/** Comprador desiste do pedido pendente. */
export async function cancelPendingOrder(db: Db, actor: Actor, orderId: string) {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { userId: true, eventId: true } });
  if (!order) throw notFound();
  if (order.userId !== actor.id) throw forbidden();
  return db.$transaction(async (tx) => {
    await lockEvent(tx, order.eventId);
    return releaseOrderTx(tx, orderId, "CANCELLED", "buyer_cancelled");
  }, TX_OPTIONS);
}

export async function getOrderForBuyer(db: Db, actor: Actor, orderId: string) {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      payments: { orderBy: { createdAt: "desc" } },
      refunds: { orderBy: { createdAt: "desc" } },
      event: { include: { venue: { include: { city: true } }, city: true, organization: { select: { name: true, slug: true } } } },
      tickets: { include: { ticketType: { select: { name: true } } }, orderBy: [{ orderItemId: "asc" }, { sequence: "asc" }] },
    },
  });
  if (!order) throw notFound("Pedido não encontrado.");
  if (order.userId !== actor.id) throw forbidden();
  return order;
}
