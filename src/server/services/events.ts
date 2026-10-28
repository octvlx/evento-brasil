import "server-only";
import type { EventStatus } from "@/generated/prisma/client";
import { eventInputSchema, ticketTypeInputSchema, type EventInput, type TicketTypeInput } from "@/features/schemas";
import { onlyDigits } from "@/lib/br";
import { commissionPerUnit } from "@/features/fees/policy";
import { zonedLocalToUtc } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { slugify } from "@/lib/utils";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { assertEventPermission, assertOrgPermission, assertPlatformAdmin, type Actor } from "../auth/permissions";
import { randomToken } from "../crypto";
import { AppError, invalidState, notFound } from "../errors";
import { resolveCommissionRule } from "./commission";
import { getWizardProgress, isWizardComplete } from "./event-wizard-progress";
import { recordRelevantChange } from "./event-changes";
import { notifyEventChangeInBackground } from "./notifications";

/** Transições permitidas do ciclo de vida do evento. */
export const EVENT_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  DRAFT: ["PENDING_REVIEW", "PUBLISHED", "CANCELLED"],
  PENDING_REVIEW: ["PUBLISHED", "DRAFT", "CANCELLED"],
  PUBLISHED: ["CANCELLED", "COMPLETED"],
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
    if (currentVenueId) {
      const same = await tx.venue.findFirst({ where: { id: currentVenueId, organizationId, name: v.name, addressLine: v.addressLine, cityId: v.cityId } });
      if (same) return { venueId: same.id, cityId: same.cityId, onlineUrl: null };
    }
    const city = await tx.city.findUnique({ where: { id: v.cityId } });
    if (!city) throw new AppError("VALIDATION", "Cidade inválida.");
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
    await audit(tx, { actorUserId: actor.id, organizationId, action: "event.created", entityType: "Event", entityId: event.id });
    return event;
  });
}

/**
 * Maior quantidade de ingressos que uma única conta já tem no evento (R4): ingressos não
 * revogados em que ela é compradora ou titular (cada ingresso conta uma vez por conta) +
 * itens de pedidos aguardando pagamento ainda não vencidos.
 * Regra provisória do lado do organizador; quando `ticketsHeldByAccount` do
 * `pagamentos-financeiro` estiver no main, passar a usá-lo.
 */
export async function maxTicketsHeldBySingleAccount(client: Db | Tx, eventId: string): Promise<number> {
  const [row] = await client.$queryRaw<{ max: number | null }[]>`
    SELECT max(n)::int AS max FROM (
      SELECT account, sum(q) AS n FROM (
        SELECT DISTINCT t.id::text AS ref, a.account, 1 AS q
          FROM "IssuedTicket" t CROSS JOIN LATERAL (VALUES (t."userId"), (t."holderUserId")) AS a(account)
         WHERE t."eventId" = ${eventId} AND t.status <> 'REVOKED'
        UNION ALL
        SELECT i.id::text AS ref, o."userId" AS account, i.quantity AS q
          FROM "Order" o JOIN "OrderItem" i ON i."orderId" = o.id
         WHERE o."eventId" = ${eventId} AND o.status = 'PENDING_PAYMENT' AND o."expiresAt" > now()
      ) held GROUP BY account
    ) per_account`;
  return row?.max ?? 0;
}

export async function updateEvent(db: Db, actor: Actor, eventId: string, raw: EventInput) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const input = eventInputSchema.parse(raw);
  const { event, change } = await db.$transaction(async (tx) => {
    // Trava o evento: o "antes" da alteração relevante e a checagem de limite por conta
    // não podem ser atropelados por outra edição simultânea.
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    const current = await tx.event.findUniqueOrThrow({ where: { id: eventId } });
    if (!EDITABLE.includes(current.status)) throw invalidState("Este evento não pode mais ser editado.");
    const sold = await tx.ticketType.aggregate({ where: { eventId }, _sum: { quantitySold: true, quantityReserved: true } });
    const committed = (sold._sum.quantitySold ?? 0) + (sold._sum.quantityReserved ?? 0);
    if (input.capacity < committed) throw new AppError("VALIDATION", `Capacidade não pode ser menor que ${committed} ingressos já vendidos/reservados.`);
    // Quem já comprou não pode perder direito de reembolso: com vendas, a política
    // só pode ficar mais generosa (mais dias após a compra, menos horas de antecedência).
    if (committed > 0 && input.refundWindowDays < current.refundWindowDays)
      throw new AppError("VALIDATION", `Já há ingressos vendidos: o prazo de reembolso não pode ser menor que ${current.refundWindowDays} dias após a compra.`);
    if (committed > 0 && input.refundMinHoursBeforeEvent > current.refundMinHoursBeforeEvent)
      throw new AppError("VALIDATION", `Já há ingressos vendidos: a antecedência para reembolso não pode passar de ${current.refundMinHoursBeforeEvent} horas antes do evento.`);
    if (input.maxTicketsPerAccount !== undefined && input.maxTicketsPerAccount !== current.maxTicketsPerAccount) {
      const held = await maxTicketsHeldBySingleAccount(tx, eventId);
      if (input.maxTicketsPerAccount < held)
        throw new AppError("VALIDATION", `Uma conta já tem ${held} ingressos deste evento: o limite por conta não pode ser menor que ${held}.`);
    }
    const loc = await resolveLocation(tx, organizationId, input, current.venueId);
    const data = { ...eventData(input), ...loc };
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
      metadata: change ? { eventChangeId: change.id } : undefined,
    });
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
async function assertPriceCoversCommission(tx: Tx, organizationId: string, eventId: string, priceCents: number) {
  if (priceCents === 0) return;
  const rule = await resolveCommissionRule(tx, organizationId, eventId);
  if (rule.bearer !== "ORGANIZER") return;
  const commission = commissionPerUnit(priceCents, rule);
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
    if (!EDITABLE.includes(event.status)) throw invalidState("Este evento não pode mais ser editado.");
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
    if (input.id) {
      const tt = await tx.ticketType.findFirst({ where: { id: input.id, eventId } });
      if (!tt) throw notFound("Tipo de ingresso não encontrado.");
      if (tt.priceCents !== input.priceCents) await assertPriceCoversCommission(tx, organizationId, eventId, input.priceCents);
      if (input.quantityTotal < tt.quantitySold + tt.quantityReserved)
        throw new AppError("VALIDATION", `Quantidade mínima: ${tt.quantitySold + tt.quantityReserved} (vendidos + reservados).`);
      if (tt.quantitySold > 0 && tt.kind !== input.kind) throw new AppError("VALIDATION", "Não é possível mudar o tipo após vendas.");
      result = await tx.ticketType.update({ where: { id: tt.id }, data });
    } else {
      await assertPriceCoversCommission(tx, organizationId, eventId, input.priceCents);
      const count = await tx.ticketType.count({ where: { eventId } });
      result = await tx.ticketType.create({ data: { ...data, eventId, sortOrder: count } });
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
  const used = await db.orderItem.count({ where: { ticketTypeId } });
  if (used > 0) throw new AppError("VALIDATION", "Este ingresso já possui pedidos; oculte-o em vez de excluir.");
  await db.ticketType.delete({ where: { id: ticketTypeId } });
  await audit(db, { actorUserId: actor.id, organizationId, action: "ticket_type.deleted", entityType: "TicketType", entityId: ticketTypeId });
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
  assertPlatformAdmin(admin);
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
  assertPlatformAdmin(admin);
  await db.event.update({ where: { id: eventId }, data: { isFeatured: featured } });
  await audit(db, { actorUserId: admin.id, action: "event.featured", entityType: "Event", entityId: eventId, metadata: { featured } });
}

/** Job: eventos publicados que já terminaram passam a COMPLETED. */
export async function completeEndedEvents(db: Db, now = new Date()) {
  const { count } = await db.event.updateMany({ where: { status: "PUBLISHED", endsAt: { lt: now } }, data: { status: "COMPLETED" } });
  return count;
}

export async function archiveEvent(db: Db, actor: Actor, eventId: string) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  assertEventTransition(event.status, "ARCHIVED");
  await db.event.update({ where: { id: eventId }, data: { status: "ARCHIVED" } });
  await audit(db, { actorUserId: actor.id, organizationId, action: "event.archived", entityType: "Event", entityId: eventId });
}
