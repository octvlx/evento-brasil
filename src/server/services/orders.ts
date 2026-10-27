// Reserva de estoque e criação de pedidos.
//
// Ordem de travas (evita deadlock): sempre Event → Order.
// Toda mutação de contadores de TicketType ocorre com a linha do Event
// travada (SELECT … FOR UPDATE), e CHECKs no banco impedem overselling
// mesmo que uma regra aqui falhe.
import "server-only";
import type { OrderStatus } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { createOrderSchema, type CreateOrderInput } from "@/features/schemas";
import { computeFees, lineWithNegativePayout } from "@/features/fees/policy";
import { onlyDigits } from "@/lib/br";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { assertActive, type Actor } from "../auth/permissions";
import { randomCode } from "../crypto";
import { env } from "../env";
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
  const stale = await tx.order.findMany({ where: { eventId, status: "PENDING_PAYMENT", expiresAt: { lte: now } }, select: { id: true } });
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
  await issueTicketsTx(tx, order);
}

/**
 * Pagamento confirmado após a reserva expirar: tenta recuperar estoque.
 * Pré-condição: trava do evento. Retorna false se não há mais disponibilidade.
 */
export async function acquireLateInventoryTx(tx: Tx, order: OrderWithItems, now = new Date()): Promise<boolean> {
  const event = await tx.event.findUniqueOrThrow({ where: { id: order.eventId }, include: { ticketTypes: true } });
  if (event.status !== "PUBLISHED") return false;
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
  await issueTicketsTx(tx, order);
  return true;
}

export interface CreateOrderOptions {
  now?: Date;
  /** O provedor configurado é o simulado (marca o pedido como simulado). */
  providerIsSimulated: boolean;
}

export async function createOrder(db: Db, actor: Actor, raw: CreateOrderInput, opts: CreateOrderOptions) {
  assertActive(actor);
  const input = createOrderSchema.parse(raw);
  const now = opts.now ?? new Date();

  const existing = await db.order.findUnique({ where: { userId_idempotencyKey: { userId: actor.id, idempotencyKey: input.idempotencyKey } } });
  if (existing) return existing;

  const merged = new Map<string, (typeof input.items)[number]>();
  for (const item of input.items) {
    if (merged.has(item.ticketTypeId)) throw new AppError("VALIDATION", "Tipo de ingresso repetido no pedido.");
    merged.set(item.ticketTypeId, item);
  }

  try {
    const created = await db.$transaction(async (tx) => {
      await lockEvent(tx, input.eventId);
      const event = await tx.event.findUnique({ where: { id: input.eventId }, include: { organization: true } });
      if (!event || event.status !== "PUBLISHED") throw notFound("Evento indisponível.");
      if (event.organization.status !== "APPROVED") throw new AppError("SALES_CLOSED", "Vendas indisponíveis para este organizador.");
      if (now < event.salesStartAt) throw new AppError("SALES_CLOSED", "As vendas ainda não começaram.");
      if (now >= event.salesEndAt || now >= event.endsAt) throw new AppError("SALES_CLOSED", "As vendas deste evento foram encerradas.");

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
      if (halfRequested > 0) {
        if (!input.halfPriceDeclaration) throw new AppError("VALIDATION", "Confirme a declaração de direito à meia-entrada.");
        if (event.halfPriceQuotaBps !== null) {
          const quota = Math.floor((event.capacity * event.halfPriceQuotaBps) / 10_000);
          const used = ticketTypes.filter((t) => t.kind === "HALF_PRICE").reduce((s, t) => s + t.quantityReserved + t.quantitySold, 0);
          if (used + halfRequested > quota) throw new AppError("SOLD_OUT", "Cota de meia-entrada esgotada.");
        }
      }

      // Preços SEMPRE do banco.
      const rule = await resolveCommissionRule(tx, event.organizationId, event.id, now);
      const fees = computeFees(
        [...merged.values()].map((i) => ({ ticketTypeId: i.ticketTypeId, unitPriceCents: byId.get(i.ticketTypeId)!.priceCents, quantity: i.quantity })),
        rule,
      );
      // Guarda B1 (ADR 0002): repasse negativo quebraria o razão na confirmação do pagamento.
      if (lineWithNegativePayout(fees, rule.bearer))
        throw new AppError("VALIDATION", "O preço deste ingresso é menor que a taxa da plataforma.");
      const isFree = fees.totalCents === 0;
      if (!isFree && !["CONNECTED", "SIMULATED"].includes(event.organization.paymentAccountStatus))
        throw new AppError("SALES_CLOSED", "O organizador ainda não está habilitado para vender ingressos pagos.");
      if (!isFree && event.organization.paymentAccountStatus === "SIMULATED" && !opts.providerIsSimulated)
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
          totalCents: fees.totalCents,
          commissionCents: fees.commissionCents,
          feePolicyVersion: fees.policyVersion,
          commissionRuleId: rule.id,
          buyerName: input.buyerName,
          buyerEmail: input.buyerEmail,
          buyerPhone: input.buyerPhone ? onlyDigits(input.buyerPhone) : null,
          idempotencyKey: input.idempotencyKey,
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

      if (isFree) {
        await tx.payment.create({
          data: { orderId: order.id, provider: "none", method: "FREE", status: "PAID", amountCents: 0, idempotencyKey: `free:${order.id}`, paidAt: now },
        });
        await finalizePaidOrderTx(tx, order, now);
        await postSale(tx, order, undefined);
      }
      await audit(tx, {
        actorUserId: actor.id,
        organizationId: event.organizationId,
        action: isFree ? "order.free_issued" : "order.created",
        entityType: "Order",
        entityId: order.id,
        metadata: { totalCents: fees.totalCents, tickets: requested },
      });
      return tx.order.findUniqueOrThrow({ where: { id: order.id } });
    }, TX_OPTIONS);
    if (created.status === "PAID") notifyOrderPaid(db, created.id);
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
