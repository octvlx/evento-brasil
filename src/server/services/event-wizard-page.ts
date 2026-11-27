// Dados do assistente para um evento existente: valores do formulário, tipos de
// ingresso, estimativas de repasse e galeria. Usado no cadastro (rascunho) e na
// edição pelo assistente (`/organizador/eventos/[id]/assistente`).
import "server-only";
import type { Db } from "../db";
import type { Event, TicketType, Venue, City } from "@/generated/prisma/client";
import { computeFees } from "@/features/fees/policy";
import { limitPercentForForm } from "@/features/half-price/policy";
import type { WizardEstimate } from "@/features/organizer/event-wizard";
import type { ManagedTicketType } from "@/features/organizer/ticket-types-manager";
import { BLANK_WIZARD_VALUES, splitAddressLine, type DataStep, type WizardValues } from "@/features/organizer/wizard-steps";
import { utcToZonedLocalInput } from "@/lib/datetime";
import { cityFormValue } from "./cities";
import { resolveCommissionRule } from "./commission";
import { EVENT_IMAGE_MIN_SIDE, listEventImages, MAX_EVENT_IMAGES } from "./event-images";

export type WizardEvent = Event & {
  ticketTypes: TicketType[];
  venue: (Venue & { city: City; _count: { events: number } }) | null;
};

export const WIZARD_EVENT_INCLUDE = {
  ticketTypes: { orderBy: { sortOrder: "asc" as const } },
  venue: { include: { city: true, _count: { select: { events: true } } } },
};

/**
 * `completed` diz quais etapas têm dados reais: etapas pendentes de um rascunho
 * guardam valores provisórios no banco, que não são exibidos.
 */
export async function wizardPageData(db: Db, organizationId: string, event: WizardEvent, completed: readonly DataStep[], hasVenues: boolean) {
  const tz = event.timezone;
  const local = (d: Date) => utcToZonedLocalInput(d, tz);
  const has = (s: DataStep) => completed.includes(s);
  const BLANK = BLANK_WIZARD_VALUES;

  // Local criado para este evento (só ele usa): editável como "novo local".
  const ownVenue = event.venue && event.venue.organizationId === organizationId && event.venue._count.events === 1 ? event.venue : null;
  const initial: WizardValues = {
    ...BLANK,
    title: event.title,
    categoryId: event.categoryId,
    summary: event.summary ?? "",
    timezone: has(2) ? tz : BLANK.timezone,
    startsAtLocal: has(2) ? local(event.startsAt) : "",
    endsAtLocal: has(2) ? local(event.endsAt) : "",
    locationType: has(2) ? event.locationType : "VENUE",
    venueMode: ownVenue || (!has(2) && !hasVenues) ? "new" : "existing",
    venueId: has(2) && event.venueId && !ownVenue ? event.venueId : "",
    newVenue: ownVenue
      ? {
          ...splitAddressLine(ownVenue.addressLine ?? ""),
          name: ownVenue.name,
          district: ownVenue.district ?? "",
          postalCode: ownVenue.postalCode ? ownVenue.postalCode.replace(/^(\d{5})(\d{3})$/, "$1-$2") : "",
          ...cityFormValue(ownVenue.city),
        }
      : BLANK.newVenue,
    onlineUrl: has(2) ? (event.onlineUrl ?? "") : "",
    capacity: has(3) ? String(event.capacity) : "",
    halfPriceQuotaPercent: has(3) && event.halfPriceQuotaBps !== null ? String(limitPercentForForm(event.halfPriceQuotaBps)) : "",
    maxTicketsPerAccount: has(3) && event.maxTicketsPerAccount !== null ? String(event.maxTicketsPerAccount) : "",
    // Sem a etapa 3, o período provisório (agora → início do evento) vira sugestão.
    salesStartLocal: has(2) ? local(event.salesStartAt) : "",
    salesEndLocal: has(2) ? local(event.salesEndAt) : "",
    description: event.description,
    coverImageUrl: event.coverImageUrl ?? "",
    ageRestriction: String(event.ageRestriction),
    accessibilityInfo: event.accessibilityInfo ?? "",
    mapImageUrl: event.mapImageUrl ?? "",
    isUnlisted: event.isUnlisted,
    refundPolicy: event.refundPolicy,
    transferDeadlineHours: String(event.transferDeadlineHours),
    transferMaxTransfers: String(event.transferMaxTransfers),
    transferAllowReturn: event.transferAllowReturn,
    refundWindowDays: String(event.refundWindowDays),
    refundMinHoursBeforeEvent: String(event.refundMinHoursBeforeEvent),
  };

  // Estimativa por ingresso com a regra de comissão vigente (mesmo cálculo do pedido).
  const rule = await resolveCommissionRule(db, organizationId, event.id).catch(() => null);
  const estimates: Record<string, WizardEstimate> = {};
  if (rule) {
    for (const t of event.ticketTypes) {
      if (t.priceCents === 0) continue;
      const f = computeFees([{ ticketTypeId: t.id, unitPriceCents: t.priceCents, quantity: 1 }], rule);
      estimates[t.id] = { buyerPaysCents: f.totalCents, organizerGetsCents: f.organizerShareCents, bearer: rule.bearer };
    }
  }

  const ticketTypes: ManagedTicketType[] = event.ticketTypes.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    sector: t.sector,
    kind: t.kind,
    priceCents: t.priceCents,
    quantityTotal: t.quantityTotal,
    quantitySold: t.quantitySold,
    quantityReserved: t.quantityReserved,
    quantityRefunded: t.quantityRefunded,
    minPerOrder: t.minPerOrder,
    maxPerOrder: t.maxPerOrder,
    salesStartLocal: t.salesStartAt ? local(t.salesStartAt) : "",
    salesEndLocal: t.salesEndAt ? local(t.salesEndAt) : "",
    requiresAttendeeInfo: t.requiresAttendeeInfo,
    seated: t.seated,
    isHidden: t.isHidden,
  }));

  const images = await listEventImages(db, event.id);
  const gallery = { images: images.map((i) => ({ id: i.id, url: i.url, alt: i.alt })), max: MAX_EVENT_IMAGES, minSide: EVENT_IMAGE_MIN_SIDE };
  const sold = event.ticketTypes.reduce((s, t) => s + t.quantitySold + t.quantityReserved, 0);
  return { initial, estimates, ticketTypes, gallery, hasSales: sold > 0 };
}
