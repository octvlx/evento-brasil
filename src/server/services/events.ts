import "server-only";
import type { EventStatus } from "@/generated/prisma/client";
import { eventInputSchema, ticketTypeInputSchema, type EventInput, type TicketTypeInput } from "@/features/schemas";
import { onlyDigits } from "@/lib/br";
import { commissionPerUnit } from "@/features/fees/policy";
import { computeHalfPriceState, stockChangeError, type HalfPriceEventInput, type HalfPriceState, type HalfPriceTypeInput } from "@/features/half-price/quota";
import { zonedLocalToUtc } from "@/lib/datetime";
import { effectiveEventStatus } from "@/lib/event-lifecycle";
import { formatBRL } from "@/lib/money";
import { slugify } from "@/lib/utils";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { assertEventPermission, assertOrgPermission, type Actor, assertAdminPermission } from "../auth/permissions";
import { randomToken } from "../crypto";
import { AppError, invalidState, notFound } from "../errors";
import { resolveVenueCity } from "./cities";
import { resolveCommissionRule } from "./commission";
import { getWizardProgress, isWizardComplete } from "./event-wizard-progress";
import { recordRelevantChange } from "./event-changes";
import { halfPriceSnapshot, loadHalfPriceStateTx } from "./half-price";
import { notifyEventChangeInBackground } from "./notifications";
import { ticketsHeldByAccount } from "./orders";

/** Transições permitidas do ciclo de vida do evento. */
export const EVENT_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  DRAFT: ["PENDING_REVIEW", "PUBLISHED", "CANCELLED"],
  PENDING_REVIEW: ["PUBLISHED", "DRAFT", "CANCELLED"],
  // PUBLISHED → DRAFT só pelo organizador e sem ingressos vendidos (`unpublishEvent`).
  PUBLISHED: ["CANCELLED", "COMPLETED", "DRAFT"],
  CANCELLED: ["ARCHIVED"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function assertEventTransition(from: EventStatus, to: EventStatus) {
  if (!EVENT_TRANSITIONS[from].includes(to)) throw invalidState(`Transição de evento inválida: ${from} → ${to}.`);
}

const EDITABLE: readonly EventStatus[] = ["DRAFT", "PENDING_REVIEW", "PUBLISHED"];

export async function uniqueEventSlug(client: Db | Tx, title: string, cityName?: string | null): Promise<string> {
  const base = slugify([title, cityName].filter(Boolean).join(" ")) || "evento";
  if (!(await client.event.findUnique({ where: { slug: base }, select: { id: true } }))) return base;
  return `${base}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
}

async function resolveLocation(tx: Tx, organizationId: string, input: ReturnType<typeof eventInputSchema.parse>, currentVenueId?: string | null) {
  if (input.locationType === "ONLINE") return { venueId: null, cityId: input.cityId || null, onlineUrl: input.onlineUrl ?? null };
  if (input.newVenue) {
    const v = input.newVenue;
    // Reenvio do mesmo "novo local" na edição: mantém o local atual em vez de criar
    // outro igual (que contaria como troca de local, R8).
    // Cidade criada/reaproveitada aqui, na transação do evento (sem órfã se falhar).
    const city = await resolveVenueCity(tx, v);
    if (currentVenueId) {
      const same = await tx.venue.findFirst({ where: { id: currentVenueId, organizationId, name: v.name, addressLine: v.addressLine, cityId: city.id } });
      if (same) return { venueId: same.id, cityId: same.cityId, onlineUrl: null };
    }
    const venue = await tx.venue.create({
      data: {
        organizationId,
        cityId: city.id,
        name: v.name,
        slug: `${slugify(v.name)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`,
        addressLine: v.addressLine,
        district: v.district,
        postalCode: v.postalCode ? onlyDigits(v.postalCode) : null,
        capacity: v.capacity,
        accessibilityInfo: v.accessibilityInfo,
      },
    });
    return { venueId: venue.id, cityId: city.id, onlineUrl: null };
  }
  const venue = await tx.venue.findFirst({
    where: { id: input.venueId, OR: [{ organizationId }, { organizationId: null }] },
  });
  if (!venue) throw new AppError("VALIDATION", "Local inválido.");
  return { venueId: venue.id, cityId: venue.cityId, onlineUrl: null };
}

function eventData(input: ReturnType<typeof eventInputSchema.parse>) {
  const tz = input.timezone;
  return {
    title: input.title,
    summary: input.summary ?? null,
    description: input.description,
    categoryId: input.categoryId,
    locationType: input.locationType,
    timezone: tz,
    startsAt: zonedLocalToUtc(input.startsAtLocal, tz),
    endsAt: zonedLocalToUtc(input.endsAtLocal, tz),
    salesStartAt: zonedLocalToUtc(input.salesStartLocal, tz),
    salesEndAt: zonedLocalToUtc(input.salesEndLocal, tz),
    ageRestriction: input.ageRestriction,
    capacity: input.capacity,
    halfPriceQuotaBps: input.halfPriceQuotaPercent === undefined ? null : Math.round(input.halfPriceQuotaPercent * 100),
    maxTicketsPerAccount: input.maxTicketsPerAccount ?? null,
    transferDeadlineHours: input.transferDeadlineHours,
    transferMaxTransfers: input.transferMaxTransfers,
    transferAllowReturn: input.transferAllowReturn,
    refundPolicy: input.refundPolicy,
    refundWindowDays: input.refundWindowDays,
    refundMinHoursBeforeEvent: input.refundMinHoursBeforeEvent,
    accessibilityInfo: input.accessibilityInfo ?? null,
    coverImageUrl: input.coverImageUrl || null,
  };
}

export async function createEvent(db: Db, actor: Actor, organizationId: string, raw: EventInput) {
  await assertOrgPermission(db, actor, organizationId, "event:write");
  const input = eventInputSchema.parse(raw);
  return db.$transaction(async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (org.status === "REJECTED" || org.status === "SUSPENDED") throw invalidState("Organização sem permissão para criar eventos.");
    const loc = await resolveLocation(tx, organizationId, input);
    const city = loc.cityId ? await tx.city.findUnique({ where: { id: loc.cityId } }) : null;
    const event = await tx.event.create({
      data: { ...eventData(input), ...loc, organizationId, slug: await uniqueEventSlug(tx, input.title, city?.name), status: "DRAFT" },
    });
    await audit(tx, {
      actorUserId: actor.id, organizationId, action: "event.created", entityType: "Event", entityId: event.id,
      metadata: { transferPolicy: { transferDeadlineHours: event.transferDeadlineHours, transferMaxTransfers: event.transferMaxTransfers, transferAllowReturn: event.transferAllowReturn } },
    });
    return event;
  });
}

/**
 * Maior quantidade de ingressos que uma conta já tem no evento, se passar de `limit` (R4);
 * senão `null`. A contagem por conta é a do `pagamentos-financeiro` (`ticketsHeldByAccount`).
 * Aqui só se escolhem as contas candidatas, por um filtro mais largo que a regra (qualquer
 * status, qualquer vencimento): se titularidade e reservas da conta ficam cada uma em até
 * metade do limite, a soma não passa dele.
 */
export async function largestHoldingOverLimit(tx: Tx, eventId: string, limit: number, now = new Date()): Promise<number | null> {
  const candidates = await tx.$queryRaw<{ account: string }[]>`
    SELECT "holderUserId" AS account FROM "IssuedTicket" WHERE "eventId" = ${eventId}
     GROUP BY "holderUserId" HAVING count(*) * 2 > ${limit}
    UNION
    SELECT o."userId" AS account FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o.id
     WHERE o."eventId" = ${eventId} AND o.status = 'PENDING_PAYMENT'
     GROUP BY o."userId" HAVING sum(i.quantity) * 2 > ${limit}`;
  let largest: number | null = null;
  for (const { account } of candidates) {
    const held = await ticketsHeldByAccount(tx, account, eventId, now);
    if (held > limit && (largest === null || held > largest)) largest = held;
  }
  return largest;
}

/** Capacidade do local físico (nulo se online ou sem capacidade cadastrada). */
async function venueCapacityOf(tx: Tx, locationType: "VENUE" | "ONLINE", venueId: string | null): Promise<number | null> {
  if (locationType === "ONLINE" || !venueId) return null;
  return (await tx.venue.findUnique({ where: { id: venueId }, select: { capacity: true } }))?.capacity ?? null;
}

/**
 * L7c: recusa a mudança de estoque/capacidade que invade a reserva legal de meia-entrada.
 * O "antes" e o "depois" usam a MESMA data e local: mudança só de data nunca é barrada
 * (é auditada em `half_price.stock_changed`). Chamar com a trava do evento tomada.
 */
function guardStockChange(before: { input: HalfPriceEventInput; types: HalfPriceTypeInput[] }, afterTypes: HalfPriceTypeInput[], afterCapacity: number, now: Date): HalfPriceState {
  const stateBefore = computeHalfPriceState(before.input, before.types, now);
  const stateGuard = computeHalfPriceState({ ...before.input, capacity: afterCapacity }, afterTypes, now);
  const message = stockChangeError(stateBefore, stateGuard);
  if (message) throw new AppError("VALIDATION", message);
  return stateBefore;
}

export async function updateEvent(db: Db, actor: Actor, eventId: string, raw: EventInput) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const { event, change } = await db.$transaction(async (tx) => {
    // Trava o evento: o "antes" da alteração relevante e a checagem de limite por conta
    // não podem ser atropelados por outra edição simultânea.
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    const current = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
    const input = eventInputSchema.parse({
      ...raw,
      transferDeadlineHours: raw.transferDeadlineHours === undefined ? current.transferDeadlineHours : raw.transferDeadlineHours,
      transferMaxTransfers: raw.transferMaxTransfers === undefined ? current.transferMaxTransfers : raw.transferMaxTransfers,
      transferAllowReturn: raw.transferAllowReturn === undefined ? current.transferAllowReturn : raw.transferAllowReturn,
    });
    // Término passado conta como encerrado mesmo antes do job gravar COMPLETED.
    if (!EDITABLE.includes(effectiveEventStatus(current))) throw invalidState("Este evento não pode mais ser editado.");
    const sold = await tx.ticketType.aggregate({ where: { eventId }, _sum: { quantitySold: true, quantityReserved: true } });
    const committed = (sold._sum.quantitySold ?? 0) + (sold._sum.quantityReserved ?? 0);
    // Clientes antigos podem omitir os campos: mantenha a política já oferecida.
    const policy = {
      transferDeadlineHours: input.transferDeadlineHours,
      transferMaxTransfers: input.transferMaxTransfers,
      transferAllowReturn: input.transferAllowReturn,
    };
    if (committed > 0 && (policy.transferDeadlineHours > current.transferDeadlineHours || policy.transferMaxTransfers < current.transferMaxTransfers || (current.transferAllowReturn && !policy.transferAllowReturn)))
      throw new AppError("VALIDATION", "Já há ingressos vendidos ou reservados: a política de transferência só pode ficar mais favorável ao comprador.");
    if (input.capacity < committed) throw new AppError("VALIDATION", `Capacidade não pode ser menor que ${committed} ingressos já vendidos/reservados.`);
    // Quem já comprou não pode perder direito de reembolso: com vendas, a política
    // só pode ficar mais generosa (mais dias após a compra, menos horas de antecedência).
    if (committed > 0 && input.refundWindowDays < current.refundWindowDays)
      throw new AppError("VALIDATION", `Já há ingressos vendidos: o prazo de reembolso não pode ser menor que ${current.refundWindowDays} dias após a compra.`);
    if (committed > 0 && input.refundMinHoursBeforeEvent > current.refundMinHoursBeforeEvent)
      throw new AppError("VALIDATION", `Já há ingressos vendidos: a antecedência para reembolso não pode passar de ${current.refundMinHoursBeforeEvent} horas antes do evento.`);
    if (input.maxTicketsPerAccount !== undefined && input.maxTicketsPerAccount !== current.maxTicketsPerAccount) {
      const held = await largestHoldingOverLimit(tx, eventId, input.maxTicketsPerAccount);
      if (held !== null)
        throw new AppError("VALIDATION", `Uma conta já tem ${held} ingressos deste evento: o limite por conta não pode ser menor que ${held}.`);
    }
    const loc = await resolveLocation(tx, organizationId, input, current.venueId);
    const data = { ...eventData({ ...input, ...policy }), ...loc };
    // L7c: capacidade que invade a cota legal de meia-entrada é recusada; aumento é livre.
    const now = new Date();
    const half = await loadHalfPriceStateTx(tx, eventId, now);
    const halfBefore = guardStockChange(half, half.types, input.capacity, now);
    const halfChanged =
      current.capacity !== data.capacity ||
      current.startsAt.getTime() !== data.startsAt.getTime() ||
      current.locationType !== data.locationType ||
      current.venueId !== loc.venueId ||
      current.halfPriceQuotaBps !== data.halfPriceQuotaBps;
    const change = await recordRelevantChange(tx, {
      actorUserId: actor.id,
      event: current,
      next: { startsAt: data.startsAt, locationType: data.locationType, venueId: loc.venueId, cityId: loc.cityId },
      reason: input.changeReason,
    });
    const event = await tx.event.update({ where: { id: eventId }, data });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "event.updated",
      entityType: "Event",
      entityId: eventId,
      metadata: {
        ...(change ? { eventChangeId: change.id } : {}),
        transferPolicy: {
          before: { transferDeadlineHours: current.transferDeadlineHours, transferMaxTransfers: current.transferMaxTransfers, transferAllowReturn: current.transferAllowReturn },
          after: policy,
        },
      },
    });
    if (halfChanged) {
      const halfAfter = computeHalfPriceState(
        {
          ...half.input,
          capacity: event.capacity,
          startsAt: event.startsAt,
          halfPriceQuotaBps: event.halfPriceQuotaBps,
          venueCapacity: await venueCapacityOf(tx, event.locationType, event.venueId),
        },
        half.types,
        now,
      );
      await audit(tx, {
        actorUserId: actor.id,
        organizationId,
        action: "half_price.stock_changed",
        entityType: "Event",
        entityId: eventId,
        metadata: { source: "event.updated", before: halfPriceSnapshot(halfBefore), after: halfPriceSnapshot(halfAfter) },
      });
    }
    return { event, change };
  });
  // Fora da transação: falha de e-mail não desfaz a alteração (pode ser reenviada).
  if (change) notifyEventChangeInBackground(db, change.id);
  return event;
}

/**
 * Com a comissão descontada do repasse (bearer ORGANIZER), um preço menor que a
 * comissão por unidade daria repasse negativo e o ingresso nunca poderia ser
 * vendido (createOrder recusa). Avisa já no cadastro. Gratuito (0) é sempre válido.
 */
async function assertPriceCoversCommission(tx: Tx, organizationId: string, eventId: string, priceCents: number, halfPrice: boolean) {
  if (priceCents === 0) return;
  const rule = await resolveCommissionRule(tx, organizationId, eventId);
  if (rule.bearer !== "ORGANIZER") return;
  const commission = commissionPerUnit(priceCents, rule, halfPrice);
  if (commission > priceCents) {
    throw new AppError(
      "VALIDATION",
      `A taxa da plataforma para este preço é ${formatBRL(commission)}, maior que o próprio preço. Aumente o preço ou torne o ingresso gratuito.`,
    );
  }
}

export async function upsertTicketType(db: Db, actor: Actor, eventId: string, raw: TicketTypeInput) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const input = ticketTypeInputSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
    if (!EDITABLE.includes(effectiveEventStatus(event))) throw invalidState("Este evento não pode mais ser editado.");
    const tz = event.timezone;
    const data = {
      name: input.name,
      description: input.description ?? null,
      kind: input.kind,
      priceCents: input.priceCents,
      quantityTotal: input.quantityTotal,
      minPerOrder: input.minPerOrder,
      maxPerOrder: input.maxPerOrder,
      salesStartAt: input.salesStartLocal ? zonedLocalToUtc(input.salesStartLocal, tz) : null,
      salesEndAt: input.salesEndLocal ? zonedLocalToUtc(input.salesEndLocal, tz) : null,
      requiresAttendeeInfo: input.requiresAttendeeInfo,
      isHidden: input.isHidden,
    };
    let result;
    let afterTypes: HalfPriceTypeInput[] = [];
    let halfChanged = false;
    let halfBefore: HalfPriceState;
    const now = new Date();
    const half = await loadHalfPriceStateTx(tx, eventId, now);
    if (input.id) {
      const tt = await tx.ticketType.findFirst({ where: { id: input.id, eventId } });
      if (!tt) throw notFound("Tipo de ingresso não encontrado.");
      if (tt.priceCents !== input.priceCents || tt.kind !== input.kind)
        await assertPriceCoversCommission(tx, organizationId, eventId, input.priceCents, input.kind === "HALF_PRICE");
      if (input.quantityTotal < tt.quantitySold + tt.quantityReserved)
        throw new AppError("VALIDATION", `Quantidade mínima: ${tt.quantitySold + tt.quantityReserved} (vendidos + reservados).`);
      if (tt.quantitySold > 0 && tt.kind !== input.kind) throw new AppError("VALIDATION", "Não é possível mudar o tipo após vendas.");
      // L7c: estoque, tipo, visibilidade ou preço não podem invadir a cota legal de meia-entrada.
      afterTypes = half.types.map((t) => (t.id === tt.id ? { ...t, kind: data.kind, priceCents: data.priceCents, isHidden: data.isHidden, quantityTotal: data.quantityTotal } : t));
      halfChanged = tt.kind !== data.kind || tt.priceCents !== data.priceCents || tt.isHidden !== data.isHidden || tt.quantityTotal !== data.quantityTotal;
      halfBefore = guardStockChange(half, afterTypes, half.input.capacity, now);
      result = await tx.ticketType.update({ where: { id: tt.id }, data });
    } else {
      await assertPriceCoversCommission(tx, organizationId, eventId, input.priceCents, input.kind === "HALF_PRICE");
      afterTypes = [...half.types, { id: "novo", kind: data.kind, priceCents: data.priceCents, isHidden: data.isHidden, quantityTotal: data.quantityTotal, quantityReserved: 0, quantitySold: 0 }];
      halfChanged = true;
      halfBefore = guardStockChange(half, afterTypes, half.input.capacity, now);
      const count = await tx.ticketType.count({ where: { eventId } });
      result = await tx.ticketType.create({ data: { ...data, eventId, sortOrder: count } });
    }
    if (halfChanged) {
      await audit(tx, {
        actorUserId: actor.id,
        organizationId,
        action: "half_price.stock_changed",
        entityType: "TicketType",
        entityId: result.id,
        metadata: {
          source: input.id ? "ticket_type.updated" : "ticket_type.created",
          eventId,
          before: halfPriceSnapshot(halfBefore),
          after: halfPriceSnapshot(computeHalfPriceState(half.input, afterTypes, now)),
        },
      });
    }
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: input.id ? "ticket_type.updated" : "ticket_type.created",
      entityType: "TicketType",
      entityId: result.id,
      metadata: { priceCents: input.priceCents, quantityTotal: input.quantityTotal },
    });
    return result;
  });
}

export async function deleteTicketType(db: Db, actor: Actor, ticketTypeId: string) {
  const tt = await db.ticketType.findUnique({ where: { id: ticketTypeId } });
  if (!tt) throw notFound();
  const { organizationId } = await assertEventPermission(db, actor, tt.eventId, "event:write");
  await db.$transaction(async (tx) => {
    // Sob a trava do evento: pedido e checagem da cota não correm junto com a exclusão.
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${tt.eventId} FOR UPDATE`;
    const used = await tx.orderItem.count({ where: { ticketTypeId } });
    if (used > 0) throw new AppError("VALIDATION", "Este ingresso já possui pedidos; oculte-o em vez de excluir.");
    const now = new Date();
    const half = await loadHalfPriceStateTx(tx, tt.eventId, now);
    const afterTypes = half.types.filter((t) => t.id !== ticketTypeId);
    // L7c: remover um tipo reduz o estoque elegível; não pode invadir a cota legal.
    const before = guardStockChange(half, afterTypes, half.input.capacity, now);
    const { count } = await tx.ticketType.deleteMany({ where: { id: ticketTypeId } });
    if (!count) return;
    await audit(tx, { actorUserId: actor.id, organizationId, action: "ticket_type.deleted", entityType: "TicketType", entityId: ticketTypeId });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "half_price.stock_changed",
      entityType: "TicketType",
      entityId: ticketTypeId,
      metadata: { source: "ticket_type.deleted", eventId: tt.eventId, before: halfPriceSnapshot(before), after: halfPriceSnapshot(computeHalfPriceState(half.input, afterTypes, now)) },
    });
  });
}

/** Envia para publicação. Publica direto se a organização tem autoPublishEvents. */
export async function submitEventForPublication(db: Db, actor: Actor, eventId: string) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:publish");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId }, include: { organization: true, ticketTypes: true } });
    if (event.organization.status !== "APPROVED") throw new AppError("FORBIDDEN", "A organização precisa ser aprovada antes de publicar eventos.");
    if (!event.ticketTypes.length) throw new AppError("VALIDATION", "Cadastre ao menos um tipo de ingresso.");
    if (event.endsAt < new Date()) throw new AppError("VALIDATION", "O evento já terminou.");
    // Rascunho do assistente com etapa pendente ainda tem valores provisórios.
    if (!isWizardComplete(await getWizardProgress(tx, eventId))) throw new AppError("VALIDATION", "Conclua todas as etapas do cadastro do evento antes de publicar.");
    const target: EventStatus = event.organization.autoPublishEvents ? "PUBLISHED" : "PENDING_REVIEW";
    // Idempotente: um segundo envio (clique repetido) devolve o estado atual.
    if (event.status === target) return event;
    assertEventTransition(event.status, target);
    const updated = await tx.event.update({
      where: { id: eventId },
      data: { status: target, publishedAt: target === "PUBLISHED" ? new Date() : null, moderationNote: null },
    });
    await audit(tx, { actorUserId: actor.id, organizationId, action: `event.${target === "PUBLISHED" ? "published" : "submitted"}`, entityType: "Event", entityId: eventId });
    return updated;
  });
}

export async function moderateEvent(db: Db, admin: Actor, eventId: string, decision: "APPROVE" | "REJECT", note?: string) {
  assertAdminPermission(admin, "events:moderate");
  if (decision === "REJECT" && !note?.trim()) throw new AppError("VALIDATION", "Informe o motivo para o organizador.");
  return db.$transaction(async (tx) => {
    // Trava o evento antes de ler o status: dois moderadores simultâneos são
    // serializados e o segundo recebe "não está aguardando moderação".
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
    if (event.status !== "PENDING_REVIEW") throw invalidState("O evento não está aguardando moderação.");
    if (decision === "APPROVE") {
      // FOR SHARE: uma suspensão concorrente da organização espera esta aprovação
      // terminar (ou a aprovação vê a organização já suspensa).
      const [organization] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "Organization" WHERE id = ${event.organizationId} FOR SHARE`;
      if (organization?.status !== "APPROVED") throw invalidState("A organização não está aprovada.");
    }
    const target: EventStatus = decision === "APPROVE" ? "PUBLISHED" : "DRAFT";
    const updated = await tx.event.update({
      where: { id: eventId },
      data: { status: target, publishedAt: target === "PUBLISHED" ? new Date() : null, moderationNote: note ?? null },
    });
    await audit(tx, {
      actorUserId: admin.id,
      organizationId: event.organizationId,
      action: decision === "APPROVE" ? "event.approved" : "event.rejected",
      entityType: "Event",
      entityId: eventId,
      metadata: { previousStatus: event.status, newStatus: target, note: note ?? null },
    });
    return updated;
  });
}

export async function setEventFeatured(db: Db, admin: Actor, eventId: string, featured: boolean) {
  assertAdminPermission(admin, "events:moderate");
  await db.event.update({ where: { id: eventId }, data: { isFeatured: featured } });
  await audit(db, { actorUserId: admin.id, action: "event.featured", entityType: "Event", entityId: eventId, metadata: { featured } });
}

/**
 * Job: eventos publicados cujo término chegou passam a COMPLETED. Um UPDATE só,
 * condicionado ao status: repetir (ou rodar em paralelo) não tem efeito extra, e
 * cancelados, rascunhos e já encerrados ficam como estão. Mexe apenas no status do
 * evento: pedidos, ingressos, QR Codes, check-ins e o razão continuam intactos.
 */
export async function completeEndedEvents(db: Db, now = new Date()) {
  const { count } = await db.event.updateMany({ where: { status: "PUBLISHED", endsAt: { lte: now } }, data: { status: "COMPLETED" } });
  return count;
}

export async function archiveEvent(db: Db, actor: Actor, eventId: string) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  assertEventTransition(effectiveEventStatus(event), "ARCHIVED");
  await db.event.update({ where: { id: eventId }, data: { status: "ARCHIVED" } });
  await audit(db, { actorUserId: actor.id, organizationId, action: "event.archived", entityType: "Event", entityId: eventId });
}

/**
 * Tira o evento do ar (PUBLISHED) ou da fila de moderação (PENDING_REVIEW) e volta a
 * rascunho. Com ingresso válido/usado ou pedido aguardando pagamento é recusado: aí o
 * caminho é cancelar, que reembolsa. A trava do evento é a mesma de `createOrder`, então
 * uma compra simultânea ou termina antes (e a despublicação é recusada) ou já encontra
 * o evento em rascunho.
 */
export async function unpublishEvent(db: Db, actor: Actor, eventId: string, now = new Date()) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:publish");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    const event = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
    const status = effectiveEventStatus(event, now);
    if (status !== "PUBLISHED" && status !== "PENDING_REVIEW") throw invalidState("Só eventos publicados ou em moderação voltam a rascunho.");
    if (status === "PUBLISHED") {
      const [tickets, pending] = await Promise.all([
        tx.issuedTicket.count({ where: { eventId, status: { in: ["VALID", "CHECKED_IN"] } } }),
        tx.order.count({ where: { eventId, status: "PENDING_PAYMENT" } }),
      ]);
      if (tickets || pending)
        throw invalidState(
          tickets
            ? "Este evento já tem ingressos vendidos. Para tirá-lo do ar, cancele o evento: os compradores são reembolsados."
            : "Há pedidos aguardando pagamento. Tente de novo quando eles forem pagos ou expirarem.",
        );
    }
    const updated = await tx.event.update({ where: { id: eventId }, data: { status: "DRAFT", publishedAt: null } });
    await audit(tx, { actorUserId: actor.id, organizationId, action: "event.unpublished", entityType: "Event", entityId: eventId, metadata: { previousStatus: status } });
    return updated;
  });
}

/**
 * Cria um rascunho igual ao evento, numa nova data de início: todas as datas (evento,
 * vendas e janelas dos tipos de ingresso) andam o mesmo intervalo. Copia dados, local e
 * tipos de ingresso (contadores zerados). Não copia cupons, links de divulgação, equipe,
 * regras de comissão nem o regime de meia-entrada (esses dependem do admin): o novo evento
 * fica com os padrões e passa pela publicação/moderação normal. A galeria de fotos é copiada.
 */
export async function duplicateEvent(db: Db, actor: Actor, eventId: string, startsAtLocal: string, now = new Date()) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const source = await db.event.findUniqueOrThrow({ where: { id: eventId }, include: { ticketTypes: { orderBy: { sortOrder: "asc" } }, city: { select: { name: true } }, images: { orderBy: { sortOrder: "asc" } } } });
  let startsAt: Date;
  try {
    startsAt = zonedLocalToUtc(startsAtLocal, source.timezone);
  } catch {
    throw new AppError("VALIDATION", "Informe a data e a hora de início do novo evento.");
  }
  if (startsAt <= now) throw new AppError("VALIDATION", "A nova data de início precisa estar no futuro.");
  const shift = startsAt.getTime() - source.startsAt.getTime();
  const move = (d: Date) => new Date(d.getTime() + shift);
  const moveOrNull = (d: Date | null) => (d ? move(d) : null);
  return db.$transaction(async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (org.status === "REJECTED" || org.status === "SUSPENDED") throw invalidState("Organização sem permissão para criar eventos.");
    const event = await tx.event.create({
      data: {
        organizationId,
        slug: await uniqueEventSlug(tx, source.title, source.city?.name),
        status: "DRAFT",
        title: source.title,
        summary: source.summary,
        description: source.description,
        categoryId: source.categoryId,
        coverImageUrl: source.coverImageUrl,
        locationType: source.locationType,
        venueId: source.venueId,
        onlineUrl: source.onlineUrl,
        cityId: source.cityId,
        timezone: source.timezone,
        startsAt,
        endsAt: move(source.endsAt),
        salesStartAt: move(source.salesStartAt),
        salesEndAt: move(source.salesEndAt),
        ageRestriction: source.ageRestriction,
        capacity: source.capacity,
        halfPriceQuotaBps: source.halfPriceQuotaBps,
        maxTicketsPerAccount: source.maxTicketsPerAccount,
        refundPolicy: source.refundPolicy,
        refundWindowDays: source.refundWindowDays,
        refundMinHoursBeforeEvent: source.refundMinHoursBeforeEvent,
        transferDeadlineHours: source.transferDeadlineHours,
        transferMaxTransfers: source.transferMaxTransfers,
        transferAllowReturn: source.transferAllowReturn,
        accessibilityInfo: source.accessibilityInfo,
      },
    });
    // A galeria vem junto (mesmos arquivos; remover na cópia não apaga o arquivo).
    if (source.images.length)
      await tx.eventImage.createMany({ data: source.images.map((i) => ({ eventId: event.id, url: i.url, storageKey: i.storageKey, alt: i.alt, sortOrder: i.sortOrder })) });
    if (source.ticketTypes.length)
      await tx.ticketType.createMany({
        data: source.ticketTypes.map((t) => ({
          eventId: event.id,
          name: t.name,
          description: t.description,
          kind: t.kind,
          priceCents: t.priceCents,
          quantityTotal: t.quantityTotal,
          minPerOrder: t.minPerOrder,
          maxPerOrder: t.maxPerOrder,
          salesStartAt: moveOrNull(t.salesStartAt),
          salesEndAt: moveOrNull(t.salesEndAt),
          requiresAttendeeInfo: t.requiresAttendeeInfo,
          isHidden: t.isHidden,
          sortOrder: t.sortOrder,
        })),
      });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "event.duplicated",
      entityType: "Event",
      entityId: event.id,
      metadata: {
        sourceEventId: source.id,
        ticketTypes: source.ticketTypes.length,
        transferPolicy: { transferDeadlineHours: event.transferDeadlineHours, transferMaxTransfers: event.transferMaxTransfers, transferAllowReturn: event.transferAllowReturn },
      },
    });
    return event;
  });
}

// ───────────────────────────── Lista do painel (busca, situação, páginas) ─────────────────────────────

export const ORGANIZER_EVENTS_PAGE_SIZE = 20;

/** Filtro de situação da lista do organizador. "Publicado" e "Encerrado" usam o relógio, como a tela. */
export const ORGANIZER_EVENT_FILTERS = ["DRAFT", "PENDING_REVIEW", "PUBLISHED", "COMPLETED", "CANCELLED", "ARCHIVED"] as const;
export type OrganizerEventFilter = (typeof ORGANIZER_EVENT_FILTERS)[number];

function statusWhere(status: OrganizerEventFilter | undefined, now: Date) {
  switch (status) {
    case "PUBLISHED":
      return { status: "PUBLISHED" as const, endsAt: { gt: now } };
    // Encerrado: status COMPLETED ou publicado com término já passado (antes do job).
    case "COMPLETED":
      return { OR: [{ status: "COMPLETED" as const }, { status: "PUBLISHED" as const, endsAt: { lte: now } }] };
    case undefined:
      return {};
    default:
      return { status };
  }
}

/** Eventos da organização com busca no título, filtro de situação e paginação (início mais recente primeiro). */
export async function listOrganizationEventsPage(
  db: Db,
  actor: Actor,
  organizationId: string,
  opts: { q?: string; status?: OrganizerEventFilter; page?: number; pageSize?: number } = {},
  now = new Date(),
) {
  await assertOrgPermission(db, actor, organizationId, "org:read");
  const q = (opts.q ?? "").trim().slice(0, 100);
  const where = {
    organizationId,
    ...statusWhere(opts.status, now),
    ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
  };
  const pageSize = opts.pageSize ?? ORGANIZER_EVENTS_PAGE_SIZE;
  const [total, all] = await Promise.all([db.event.count({ where }), db.event.count({ where: { organizationId } })]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);
  const rows = await db.event.findMany({
    where,
    include: {
      ticketTypes: { select: { quantityTotal: true, quantitySold: true, quantityReserved: true } },
      city: true,
      _count: { select: { tickets: { where: { status: "CHECKED_IN" } } } },
    },
    orderBy: [{ startsAt: "desc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { rows, total, all, page, pageCount, q, status: opts.status };
}
