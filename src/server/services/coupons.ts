// Cupons de desconto: cadastro pelo organizador (ADR 0002, passo 3).
//
// Este módulo só administra o cupom. Validar o código no checkout, aplicar o
// desconto e mexer nos contadores (timesReserved/timesRedeemed) é do fluxo de
// pedidos (`orders.ts`, pagamentos-financeiro) — aqui os contadores só são lidos.
import "server-only";
import { Prisma, type EventStatus, type TicketType } from "@/generated/prisma/client";
import { couponInputSchema, type CouponInput } from "@/features/schemas";
import { discountPerUnit, undercutHalfPrice, type DiscountSpec } from "@/features/fees/discount";
import { commissionPerUnit } from "@/features/fees/policy";
import { zonedLocalToUtc } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { assertEventPermission, assertOrgPermission, type Actor } from "../auth/permissions";
import { AppError, invalidState, notFound } from "../errors";
import { resolveCommissionRule } from "./commission";
import { lockEvent, lockCoupons } from "./orders";

const EDITABLE: readonly EventStatus[] = ["DRAFT", "PENDING_REVIEW", "PUBLISHED"];

/** Validade de cupom da organização inteira: não há evento, vale o horário de Brasília. */
export const ORG_COUPON_TIMEZONE = "America/Sao_Paulo";

/** Quantos eventos abertos entram nos avisos de um cupom da organização inteira. */
const ORG_WARNING_EVENTS = 30;


/** Tipos a que o cupom se aplica: pagos, sem meia-entrada (D3), filtrados pela lista quando houver. */
function eligibleTypes(types: TicketType[], ticketTypeIds: string[]) {
  return types.filter((t) => t.priceCents > 0 && t.kind !== "HALF_PRICE" && (ticketTypeIds.length === 0 || ticketTypeIds.includes(t.id)));
}

/**
 * Avisos para o organizador (não bloqueiam o cadastro): casos em que o pedido
 * com o cupom será recusado no checkout — repasse negativo (B1) e inteira com
 * desconto mais barata que a meia (D3, até a revisão jurídica).
 */
async function couponWarnings(tx: Tx, organizationId: string, eventId: string, types: TicketType[], spec: DiscountSpec, ticketTypeIds: string[]) {
  const warnings: string[] = [];
  const rule = await resolveCommissionRule(tx, organizationId, eventId);
  // Mesmo conjunto que o checkout usa (createOrder): meias visíveis.
  const halfPrices = types.filter((t) => t.kind === "HALF_PRICE" && !t.isHidden).map((t) => t.priceCents);
  for (const t of eligibleTypes(types, ticketTypeIds)) {
    const net = t.priceCents - discountPerUnit(t.priceCents, spec);
    if (rule.bearer === "ORGANIZER" && net > 0 && commissionPerUnit(net, rule) > net) {
      warnings.push(`"${t.name}": com o desconto o preço (${formatBRL(net)}) fica abaixo da taxa da plataforma; o cupom será recusado nesse ingresso.`);
    }
    // Só quando é o cupom que leva abaixo da meia: um tipo que já custa menos que a meia não é afetado.
    // Mesma regra do checkout: só quando é o cupom que leva abaixo da meia; cortesia (100%) fica fora.
    const half = undercutHalfPrice(t.priceCents, net, halfPrices);
    if (half !== undefined) {
      warnings.push(`"${t.name}": com o desconto (${formatBRL(net)}) fica mais barato que a meia-entrada (${formatBRL(half)}); o cupom será recusado nesse ingresso até a revisão jurídica.`);
    }
  }
  return warnings;
}

/**
 * Avisos de um cupom da organização inteira: os mesmos do cupom de evento, para cada
 * evento ainda aberto (rascunho, em moderação ou publicado e não encerrado), com o
 * nome do evento na frente.
 */
async function organizationCouponWarnings(tx: Tx, organizationId: string, spec: DiscountSpec, now = new Date()) {
  const events = await tx.event.findMany({
    where: { organizationId, status: { in: [...EDITABLE] }, endsAt: { gt: now } },
    include: { ticketTypes: true },
    orderBy: { startsAt: "asc" },
    take: ORG_WARNING_EVENTS,
  });
  const out: string[] = [];
  for (const e of events) for (const w of await couponWarnings(tx, organizationId, e.id, e.ticketTypes, spec, [])) out.push(`${e.title} — ${w}`);
  return out;
}

function assertNoTicketTypes(ids: string[]) {
  if (ids.length) throw new AppError("VALIDATION", "Cupom da organização inteira vale para todos os tipos pagos (sem meia-entrada) de todos os eventos; para restringir a tipos, crie o cupom na página do evento.");
}

async function loadEditableEvent(tx: Tx, eventId: string) {
  const event = await tx.event.findUniqueOrThrow({ where: { id: eventId }, include: { ticketTypes: true } });
  if (!EDITABLE.includes(event.status)) throw invalidState("Este evento não aceita mais cupons.");
  return event;
}

function assertTicketTypes(types: TicketType[], ids: string[]) {
  for (const id of ids) {
    const t = types.find((x) => x.id === id);
    if (!t) throw new AppError("VALIDATION", "Tipo de ingresso inválido para este evento.");
    if (t.kind === "HALF_PRICE") throw new AppError("VALIDATION", "Cupons não se aplicam à meia-entrada (pendente de revisão jurídica).");
    if (t.priceCents === 0) throw new AppError("VALIDATION", `"${t.name}" é gratuito: não há o que descontar.`);
  }
}

function couponData(input: ReturnType<typeof couponInputSchema.parse>, timezone: string) {
  return {
    code: input.code,
    description: input.description ?? null,
    discountType: input.discountType,
    percentBps: input.percentBps,
    amountCents: input.amountCents,
    validFrom: input.validFromLocal ? zonedLocalToUtc(input.validFromLocal, timezone) : null,
    validUntil: input.validUntilLocal ? zonedLocalToUtc(input.validUntilLocal, timezone) : null,
    maxUses: input.maxUses,
    maxUsesPerUser: input.maxUsesPerUser,
  };
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const duplicateCode = () => new AppError("CONFLICT", "Já existe um cupom com este código nesta organização.");

const isUsed = (c: { timesReserved: number; timesRedeemed: number; _count: { orders: number } }) => c.timesReserved + c.timesRedeemed + c._count.orders > 0;

/** Cupons do evento (os da organização inteira também valem para ele). */
export async function listEventCoupons(db: Db, actor: Actor, eventId: string) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const coupons = await db.coupon.findMany({
    where: { organizationId, OR: [{ eventId }, { eventId: null }] },
    include: { ticketTypes: { select: { ticketTypeId: true } }, _count: { select: { orders: true } } },
    orderBy: { createdAt: "desc" },
  });
  return coupons.map(couponView);
}

export async function createCoupon(db: Db, actor: Actor, eventId: string, raw: CouponInput) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const input = couponInputSchema.parse(raw);
  try {
    return await db.$transaction(async (tx) => {
      const event = await loadEditableEvent(tx, eventId);
      assertTicketTypes(event.ticketTypes, input.ticketTypeIds);
      const coupon = await tx.coupon.create({
        data: {
          ...couponData(input, event.timezone),
          organizationId,
          eventId,
          createdById: actor.id,
          ticketTypes: { create: input.ticketTypeIds.map((ticketTypeId) => ({ ticketTypeId })) },
        },
      });
      await audit(tx, {
        actorUserId: actor.id,
        organizationId,
        action: "coupon.created",
        entityType: "Coupon",
        entityId: coupon.id,
        metadata: { eventId, code: coupon.code, discountType: coupon.discountType, percentBps: coupon.percentBps, amountCents: coupon.amountCents },
      });
      return { coupon, warnings: await couponWarnings(tx, organizationId, eventId, event.ticketTypes, input, input.ticketTypeIds) };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateCode();
    throw err;
  }
}

function couponView(c: Prisma.CouponGetPayload<{ include: { ticketTypes: { select: { ticketTypeId: true } }; _count: { select: { orders: true } } } }>) {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    discountType: c.discountType,
    percentBps: c.percentBps,
    amountCents: c.amountCents,
    validFrom: c.validFrom,
    validUntil: c.validUntil,
    maxUses: c.maxUses,
    maxUsesPerUser: c.maxUsesPerUser,
    timesReserved: c.timesReserved,
    timesRedeemed: c.timesRedeemed,
    disabled: c.disabledAt !== null,
    organizationWide: c.eventId === null,
    ticketTypeIds: c.ticketTypes.map((t) => t.ticketTypeId),
    used: isUsed(c),
  };
}

/** Cupons da organização inteira (sem evento). Os de evento ficam na página do evento. */
export async function listOrganizationCoupons(db: Db, actor: Actor, organizationId: string) {
  await assertOrgPermission(db, actor, organizationId, "event:write");
  const coupons = await db.coupon.findMany({
    where: { organizationId, eventId: null },
    include: { ticketTypes: { select: { ticketTypeId: true } }, _count: { select: { orders: true } } },
    orderBy: { createdAt: "desc" },
  });
  return coupons.map(couponView);
}

/** Cupom válido em todos os eventos da organização (ADR 0002: `eventId = null`). */
export async function createOrganizationCoupon(db: Db, actor: Actor, organizationId: string, raw: CouponInput) {
  await assertOrgPermission(db, actor, organizationId, "event:write");
  const input = couponInputSchema.parse(raw);
  assertNoTicketTypes(input.ticketTypeIds);
  try {
    return await db.$transaction(async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { status: true } });
      if (org.status === "REJECTED" || org.status === "SUSPENDED") throw invalidState("Organização sem permissão para criar cupons.");
      const coupon = await tx.coupon.create({
        data: { ...couponData(input, ORG_COUPON_TIMEZONE), organizationId, eventId: null, createdById: actor.id },
      });
      await audit(tx, {
        actorUserId: actor.id,
        organizationId,
        action: "coupon.created",
        entityType: "Coupon",
        entityId: coupon.id,
        metadata: { eventId: null, code: coupon.code, discountType: coupon.discountType, percentBps: coupon.percentBps, amountCents: coupon.amountCents },
      });
      return { coupon, warnings: await organizationCouponWarnings(tx, organizationId, input) };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateCode();
    throw err;
  }
}

async function loadCouponForManager(tx: Tx, actor: Actor, couponId: string) {
  const coupon = await tx.coupon.findUnique({ where: { id: couponId }, include: { _count: { select: { orders: true } } } });
  if (!coupon) throw notFound("Cupom não encontrado.");
  await assertOrgPermission(tx, actor, coupon.organizationId, "event:write");
  return coupon;
}

/**
 * Edita o cupom. Depois do primeiro uso, código e desconto ficam fixos (os
 * pedidos guardam o código e o desconto aplicados; mudar confundiria os
 * relatórios). Validade, limites, descrição e tipos continuam editáveis.
 */
export async function updateCoupon(db: Db, actor: Actor, couponId: string, raw: CouponInput) {
  const input = couponInputSchema.parse(raw);
  try {
    return await db.$transaction(async (tx) => {
      const ref = await loadCouponForManager(tx, actor, couponId);
      // Mesma ordem de travas do checkout (evento → cupom); cupom da organização não tem evento.
      if (ref.eventId) await lockEvent(tx, ref.eventId);
      await lockCoupons(tx, [couponId]);
      const current = await loadCouponForManager(tx, actor, couponId);
      if ((current.eventId ?? null) !== (ref.eventId ?? null)) throw invalidState("O cupom mudou; atualize a página.");
      const event = current.eventId ? await loadEditableEvent(tx, current.eventId) : null;
      if (event) assertTicketTypes(event.ticketTypes, input.ticketTypeIds);
      else assertNoTicketTypes(input.ticketTypeIds);
      const used = isUsed(current);
      if (
        used &&
        (input.code !== current.code ||
          input.discountType !== current.discountType ||
          input.percentBps !== current.percentBps ||
          input.amountCents !== current.amountCents)
      ) {
        throw new AppError("VALIDATION", "Este cupom já foi usado: código e desconto não podem mais mudar. Crie outro cupom.");
      }
      await tx.couponTicketType.deleteMany({ where: { couponId } });
      const coupon = await tx.coupon.update({
        where: { id: couponId },
        data: { ...couponData(input, event?.timezone ?? ORG_COUPON_TIMEZONE), ticketTypes: { create: input.ticketTypeIds.map((ticketTypeId) => ({ ticketTypeId })) } },
      });
      await audit(tx, {
        actorUserId: actor.id,
        organizationId: current.organizationId,
        action: "coupon.updated",
        entityType: "Coupon",
        entityId: couponId,
        metadata: { code: coupon.code, maxUses: coupon.maxUses, maxUsesPerUser: coupon.maxUsesPerUser },
      });
      const warnings = event
        ? await couponWarnings(tx, current.organizationId, event.id, event.ticketTypes, input, input.ticketTypeIds)
        : await organizationCouponWarnings(tx, current.organizationId, input);
      return { coupon, warnings };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateCode();
    throw err;
  }
}

export async function setCouponDisabled(db: Db, actor: Actor, couponId: string, disabled: boolean) {
  return db.$transaction(async (tx) => {
    const coupon = await loadCouponForManager(tx, actor, couponId);
    if ((coupon.disabledAt !== null) === disabled) return coupon;
    const updated = await tx.coupon.update({ where: { id: couponId }, data: { disabledAt: disabled ? new Date() : null } });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: coupon.organizationId,
      action: disabled ? "coupon.disabled" : "coupon.enabled",
      entityType: "Coupon",
      entityId: couponId,
      metadata: { code: coupon.code },
    });
    return updated;
  });
}

/** Só cupom nunca usado pode ser apagado (o banco também impede: onDelete Restrict). */
export async function deleteCoupon(db: Db, actor: Actor, couponId: string) {
  await db.$transaction(async (tx) => {
    const coupon = await loadCouponForManager(tx, actor, couponId);
    if (isUsed(coupon)) throw invalidState("Este cupom já foi usado: desative-o em vez de apagar.");
    await tx.coupon.delete({ where: { id: couponId } });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: coupon.organizationId,
      action: "coupon.deleted",
      entityType: "Coupon",
      entityId: couponId,
      metadata: { code: coupon.code },
    });
  });
}
