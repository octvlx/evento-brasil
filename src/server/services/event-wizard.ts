import "server-only";
import { z } from "zod";
import { composeAddressLine, DEFAULT_REFUND_POLICY, step1Schema, step2Schema, step3Schema, step4Schema, step5Schema, type DataStep, type WizardStep } from "@/features/organizer/wizard-steps";
import { onlyDigits } from "@/lib/br";
import { zonedLocalToUtc } from "@/lib/datetime";
import { slugify } from "@/lib/utils";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { assertEventPermission, assertOrgPermission, type Actor } from "../auth/permissions";
import { randomToken } from "../crypto";
import { AppError, invalidState, notFound } from "../errors";
import { uniqueEventSlug } from "./events";
import { getWizardProgress, recordWizardProgress, type WizardProgress } from "./event-wizard-progress";

// Assistente de criação de evento: o rascunho (DRAFT) nasce na etapa 1 e cada
// etapa grava só os próprios campos, com a mesma autorização (`event:write`) e as
// mesmas regras de `createEvent`/`updateEvent`. Campos de etapas ainda não
// concluídas guardam valores provisórios (o schema exige datas e capacidade);
// a interface não os mostra e `submitEventForPublication` recusa publicar
// enquanto houver etapa pendente.

const DAY = 86_400_000;
const HOUR = 3_600_000;

const draftKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "Identificador de rascunho inválido.");

/**
 * Cria (ou recupera) o rascunho da etapa 1. `draftKey` é gerado pelo navegador
 * uma vez por formulário: cliques repetidos, autosave e o botão "Continuar"
 * chegando juntos devolvem o MESMO evento (a linha da organização é travada
 * enquanto a chave é procurada).
 */
export async function startEventDraft(db: Db, actor: Actor, organizationId: string, raw: { draftKey: string } & Record<string, unknown>) {
  await assertOrgPermission(db, actor, organizationId, "event:write");
  const draftKey = parseOrThrow(draftKeySchema, raw.draftKey);
  const input = parseOrThrow(step1Schema, raw);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`;
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    if (org.status === "REJECTED" || org.status === "SUSPENDED") throw invalidState("Organização sem permissão para criar eventos.");
    const previous = await tx.auditLog.findFirst({
      where: {
        action: "event.wizard_started",
        organizationId,
        actorUserId: actor.id,
        metadata: { path: ["draftKey"], equals: draftKey },
      },
      select: { entityId: true },
    });
    if (previous) {
      const existing = await tx.event.findFirst({
        where: { id: previous.entityId, organizationId },
      });
      if (existing) return { event: existing, created: false };
    }
    if (
      !(await tx.eventCategory.findUnique({
        where: { id: input.categoryId },
        select: { id: true },
      }))
    )
      throw new AppError("VALIDATION", "Categoria inválida.");
    // Provisórios (não exibidos): início em 30 dias, vendas abertas até o início.
    const startsAt = new Date(Math.ceil((Date.now() + 30 * DAY) / HOUR) * HOUR);
    const event = await tx.event.create({
      data: {
        organizationId,
        slug: await uniqueEventSlug(tx, input.title),
        status: "DRAFT",
        title: input.title,
        summary: input.summary ?? null,
        categoryId: input.categoryId,
        description: "",
        locationType: "VENUE",
        timezone: "America/Sao_Paulo",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * HOUR),
        salesStartAt: new Date(),
        salesEndAt: startsAt,
        capacity: 100,
        refundPolicy: DEFAULT_REFUND_POLICY,
      },
    });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "event.created",
      entityType: "Event",
      entityId: event.id,
    });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "event.wizard_started",
      entityType: "Event",
      entityId: event.id,
      metadata: { draftKey },
    });
    await recordWizardProgress(tx, actor, organizationId, event.id, {
      lastStep: 1,
    });
    return { event, created: true };
  });
}

async function wizardLocation(tx: Tx, organizationId: string, eventId: string, currentVenueId: string | null, input: z.output<typeof step2Schema>) {
  if (input.locationType === "ONLINE")
    return {
      locationType: "ONLINE" as const,
      venueId: null,
      cityId: null,
      onlineUrl: input.onlineUrl ?? null,
    };
  if (input.venueMode === "new" && input.newVenue) {
    const v = input.newVenue;
    const city = await tx.city.findUnique({ where: { id: v.cityId } });
    if (!city) throw new AppError("VALIDATION", "Cidade inválida.");
    const data = {
      cityId: city.id,
      name: v.name,
      addressLine: composeAddressLine(v),
      district: v.district ?? null,
      postalCode: v.postalCode ? onlyDigits(v.postalCode) : null,
    };
    // O autosave reenvia o novo local várias vezes: o local criado para ESTE
    // evento (da organização e sem outros eventos) é atualizado, não duplicado.
    if (currentVenueId) {
      const own = await tx.venue.findFirst({
        where: {
          id: currentVenueId,
          organizationId,
          events: { every: { id: eventId } },
        },
        select: { id: true },
      });
      if (own) {
        await tx.venue.update({ where: { id: own.id }, data });
        return {
          locationType: "VENUE" as const,
          venueId: own.id,
          cityId: city.id,
          onlineUrl: null,
        };
      }
    }
    const venue = await tx.venue.create({
      data: {
        ...data,
        organizationId,
        slug: `${slugify(v.name)}-${randomToken(3)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "x")}`,
      },
    });
    return {
      locationType: "VENUE" as const,
      venueId: venue.id,
      cityId: city.id,
      onlineUrl: null,
    };
  }
  const venue = await tx.venue.findFirst({
    where: {
      id: input.venueId,
      OR: [{ organizationId }, { organizationId: null }],
    },
  });
  if (!venue) throw new AppError("VALIDATION", "Local inválido.");
  return {
    locationType: "VENUE" as const,
    venueId: venue.id,
    cityId: venue.cityId,
    onlineUrl: null,
  };
}

/**
 * Grava uma etapa do assistente. `complete` marca a etapa como concluída
 * (botão "Continuar"); o autosave grava sem concluir. Só para rascunhos.
 */
export async function saveEventWizardStep(db: Db, actor: Actor, eventId: string, step: DataStep, raw: Record<string, unknown>, opts: { complete: boolean }) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
    const current = await tx.event.findUniqueOrThrow({
      where: { id: eventId },
      include: { city: true },
    });
    if (current.status !== "DRAFT") throw invalidState("Este evento já foi enviado para publicação. Altere-o pela página de gestão do evento.");
    const progress = await getWizardProgress(tx, eventId);
    const tz = current.timezone;
    let data: Parameters<typeof tx.event.update>[0]["data"];

    switch (step) {
      case 1: {
        const input = parseOrThrow(step1Schema, raw);
        if (
          !(await tx.eventCategory.findUnique({
            where: { id: input.categoryId },
            select: { id: true },
          }))
        )
          throw new AppError("VALIDATION", "Categoria inválida.");
        data = {
          title: input.title,
          summary: input.summary ?? null,
          categoryId: input.categoryId,
        };
        if (!current.publishedAt) data.slug = await refreshedSlug(tx, current.slug, input.title, current.city?.name);
        break;
      }
      case 2: {
        const input = parseOrThrow(step2Schema, raw);
        const startsAt = zonedLocalToUtc(input.startsAtLocal, input.timezone);
        const endsAt = zonedLocalToUtc(input.endsAtLocal, input.timezone);
        const loc = await wizardLocation(tx, organizationId, eventId, current.venueId, input);
        const city = loc.cityId ? await tx.city.findUnique({ where: { id: loc.cityId } }) : null;
        data = { timezone: input.timezone, startsAt, endsAt, ...loc };
        if (!progress.completed.includes(3)) {
          // Período de vendas ainda provisório: acompanha a data do evento.
          data.salesStartAt = new Date(Math.min(Date.now(), startsAt.getTime()));
          data.salesEndAt = startsAt;
        } else if (current.salesEndAt > endsAt) {
          throw new AppError("VALIDATION", "As vendas terminariam depois do fim do evento. Ajuste o período de vendas na etapa 3 antes de mudar a data.");
        }
        if (!current.publishedAt) data.slug = await refreshedSlug(tx, current.slug, current.title, city?.name);
        break;
      }
      case 3: {
        const input = parseOrThrow(step3Schema, raw);
        if (!progress.completed.includes(2)) throw new AppError("VALIDATION", "Conclua a etapa 2 (data e localização) primeiro.");
        const salesStartAt = zonedLocalToUtc(input.salesStartLocal, tz);
        const salesEndAt = zonedLocalToUtc(input.salesEndLocal, tz);
        if (salesEndAt > current.endsAt) throw new AppError("VALIDATION", "As vendas devem terminar até o fim do evento.");
        await assertCapacity(tx, eventId, input.capacity);
        data = {
          capacity: input.capacity,
          halfPriceQuotaBps: input.halfPriceQuotaPercent === undefined ? null : Math.round(input.halfPriceQuotaPercent * 100),
          // Rascunho: sem vendas, então não há conta acima do limite.
          maxTicketsPerAccount: input.maxTicketsPerAccount ?? null,
          salesStartAt,
          salesEndAt,
        };
        if (opts.complete && !(await tx.ticketType.count({ where: { eventId } }))) throw new AppError("VALIDATION", "Cadastre ao menos um tipo de ingresso para continuar.");
        break;
      }
      case 4: {
        const input = parseOrThrow(step4Schema, raw);
        data = {
          description: input.description,
          coverImageUrl: input.coverImageUrl || null,
          ageRestriction: input.ageRestriction,
          accessibilityInfo: input.accessibilityInfo ?? null,
        };
        break;
      }
      case 5: {
        const input = parseOrThrow(step5Schema, {
          ...raw,
          transferDeadlineHours: raw.transferDeadlineHours === undefined ? current.transferDeadlineHours : raw.transferDeadlineHours,
          transferMaxTransfers: raw.transferMaxTransfers === undefined ? current.transferMaxTransfers : raw.transferMaxTransfers,
          transferAllowReturn: raw.transferAllowReturn === undefined ? current.transferAllowReturn : raw.transferAllowReturn,
        });
        data = {
          transferDeadlineHours: input.transferDeadlineHours,
          transferMaxTransfers: input.transferMaxTransfers,
          transferAllowReturn: input.transferAllowReturn,
          refundPolicy: input.refundPolicy,
          refundWindowDays: input.refundWindowDays,
          refundMinHoursBeforeEvent: input.refundMinHoursBeforeEvent,
        };
        break;
      }
    }

    const event = await tx.event.update({ where: { id: eventId }, data });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "event.updated",
      entityType: "Event",
      entityId: eventId,
      metadata: {
        wizardStep: step,
        ...(step === 5 ? { transferPolicy: {
          before: { transferDeadlineHours: current.transferDeadlineHours, transferMaxTransfers: current.transferMaxTransfers, transferAllowReturn: current.transferAllowReturn },
          after: { transferDeadlineHours: event.transferDeadlineHours, transferMaxTransfers: event.transferMaxTransfers, transferAllowReturn: event.transferAllowReturn },
        } } : {}),
      },
    });
    const next: WizardProgress = await recordWizardProgress(tx, actor, organizationId, eventId, { complete: opts.complete ? step : undefined, lastStep: step });
    return { event, progress: next };
  });
}

/** Registra a etapa aberta por último (para retomar de onde parou). */
export async function recordWizardVisit(db: Db, actor: Actor, eventId: string, step: WizardStep) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { status: true },
  });
  if (!event) throw notFound();
  if (event.status !== "DRAFT") return getWizardProgress(db, eventId);
  return recordWizardProgress(db, actor, organizationId, eventId, {
    lastStep: step,
  });
}

/** Erros de validação viram mensagem para o organizador (a primeira encontrada). */
function parseOrThrow<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const res = schema.safeParse(raw);
  if (!res.success) throw new AppError("VALIDATION", res.error.issues[0]?.message ?? "Dados inválidos.");
  return res.data;
}

async function assertCapacity(tx: Tx, eventId: string, capacity: number) {
  const sold = await tx.ticketType.aggregate({
    where: { eventId },
    _sum: { quantitySold: true, quantityReserved: true },
  });
  const committed = (sold._sum.quantitySold ?? 0) + (sold._sum.quantityReserved ?? 0);
  if (capacity < committed) throw new AppError("VALIDATION", `Capacidade não pode ser menor que ${committed} ingressos já vendidos/reservados.`);
}

/** Rascunho nunca publicado: o endereço acompanha título e cidade. */
async function refreshedSlug(tx: Tx, currentSlug: string, title: string, cityName?: string | null) {
  const base = slugify([title, cityName].filter(Boolean).join(" ")) || "evento";
  if (currentSlug === base || new RegExp(`^${base}-[a-z0-9]{1,12}$`).test(currentSlug)) return currentSlug;
  return uniqueEventSlug(tx, title, cityName);
}
