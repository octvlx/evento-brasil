import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { EventWizard, type WizardEstimate } from "@/features/organizer/event-wizard";
import { eventFormOptions } from "@/features/organizer/form-data";
import { clampStep, DATA_STEPS, DEFAULT_REFUND_POLICY, firstIncompleteStep, splitAddressLine, WIZARD_STEPS, type WizardValues } from "@/features/organizer/wizard-steps";
import { computeFees } from "@/features/fees/policy";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { resolveCommissionRule } from "@/server/services/commission";
import { getWizardProgress, isWizardComplete, wizardProgressByEvent } from "@/server/services/event-wizard-progress";
import { formatDateTimeShort, utcToZonedLocalInput } from "@/lib/datetime";

export const metadata: Metadata = {
  title: "Novo evento",
  robots: { index: false },
};

type Search = Promise<{ evento?: string; etapa?: string }>;

export default function NewEventPage({ searchParams }: PageProps<"/organizador/eventos/novo">) {
  return (
    <Suspense fallback={<Skeleton className="h-[700px]" />}>
      <Content searchParams={searchParams as Search} />
    </Suspense>
  );
}

const BLANK: WizardValues = {
  title: "",
  categoryId: "",
  summary: "",
  timezone: "America/Sao_Paulo",
  startsAtLocal: "",
  endsAtLocal: "",
  locationType: "VENUE",
  venueMode: "existing",
  venueId: "",
  newVenue: {
    name: "",
    street: "",
    number: "",
    complement: "",
    district: "",
    postalCode: "",
    cityId: "",
  },
  onlineUrl: "",
  capacity: "",
  halfPriceQuotaPercent: "",
  maxTicketsPerAccount: "",
  salesStartLocal: "",
  salesEndLocal: "",
  description: "",
  coverImageUrl: "",
  ageRestriction: "0",
  accessibilityInfo: "",
  transferDeadlineHours: "24",
  transferMaxTransfers: "1",
  transferAllowReturn: false,
  refundPolicy: DEFAULT_REFUND_POLICY,
  refundWindowDays: "7",
  refundMinHoursBeforeEvent: "48",
};

async function Content({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const { org, can } = await requireOrganizer("/organizador/eventos/novo");
  if (!can("event:write")) redirect("/organizador");
  const [options, orgSettings] = await Promise.all([
    eventFormOptions(db, org.id),
    db.organization.findUnique({
      where: { id: org.id },
      select: { autoPublishEvents: true },
    }),
  ]);
  const common = {
    ...options,
    organizationName: org.name,
    canPublish: can("event:publish"),
    orgApproved: org.status === "APPROVED",
    autoPublish: !!orgSettings?.autoPublishEvents,
  };

  if (!sp.evento) {
    // Rascunhos do assistente ainda incompletos: oferecer continuar de onde parou.
    const drafts = await db.event.findMany({
      where: { organizationId: org.id, status: "DRAFT" },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take: 30,
    });
    const progress = await wizardProgressByEvent(
      db,
      drafts.map((d) => d.id),
    );
    const pending = drafts.filter((d) => progress.has(d.id) && !isWizardComplete(progress.get(d.id)!)).slice(0, 5);
    return (
      <>
        <PageTitle title="Novo evento" subtitle="Vamos criar seu evento em 6 etapas. O rascunho é salvo automaticamente e você pode parar e continuar depois." />
        {pending.length > 0 ? (
          <Card className="mx-auto mb-6 max-w-3xl p-5">
            <h2 className="font-display text-base font-bold">Continuar de onde parou</h2>
            <ul className="mt-3 divide-y divide-border">
              {pending.map((d) => {
                const step = firstIncompleteStep(progress.get(d.id)!.completed);
                return (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span>
                      <span className="font-semibold">{d.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        Etapa {step} de 6 ({WIZARD_STEPS[step - 1].title}) · salvo em {formatDateTimeShort(d.updatedAt)}
                      </span>
                    </span>
                    <Link href={`/organizador/eventos/novo?evento=${d.id}&etapa=${step}`} className="font-semibold text-secondary hover:underline">
                      Continuar cadastro
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : null}
        <EventWizard {...common} eventId={null} step={1} completed={[]} initial={BLANK} ticketTypes={[]} estimates={{}} />
      </>
    );
  }

  const event = await db.event.findFirst({
    where: { id: sp.evento, organizationId: org.id },
    include: {
      ticketTypes: { orderBy: { sortOrder: "asc" } },
      venue: { include: { _count: { select: { events: true } } } },
    },
  });
  if (!event) notFound();
  if (event.status !== "DRAFT") redirect(`/organizador/eventos/${event.id}/editar`);
  const progress = await getWizardProgress(db, event.id);
  // Rascunho criado fora do assistente: todos os dados já são reais.
  const completed = progress.tracked ? progress.completed : [...DATA_STEPS];
  const step = clampStep(Number(sp.etapa) || undefined, completed);
  const tz = event.timezone;
  const local = (d: Date) => utcToZonedLocalInput(d, tz);
  const has = (s: number) => completed.includes(s as never);

  // Local criado para este evento (só ele usa): editável como "novo local".
  const ownVenue = event.venue && event.venue.organizationId === org.id && event.venue._count.events === 1 ? event.venue : null;
  const initial: WizardValues = {
    ...BLANK,
    title: event.title,
    categoryId: event.categoryId,
    summary: event.summary ?? "",
    // Etapas pendentes guardam valores provisórios no banco: não exibir.
    timezone: has(2) ? tz : BLANK.timezone,
    startsAtLocal: has(2) ? local(event.startsAt) : "",
    endsAtLocal: has(2) ? local(event.endsAt) : "",
    locationType: has(2) ? event.locationType : "VENUE",
    venueMode: ownVenue || (!has(2) && !options.venues.length) ? "new" : "existing",
    venueId: has(2) && event.venueId && !ownVenue ? event.venueId : "",
    newVenue: ownVenue
      ? {
          ...splitAddressLine(ownVenue.addressLine ?? ""),
          name: ownVenue.name,
          district: ownVenue.district ?? "",
          postalCode: ownVenue.postalCode ? ownVenue.postalCode.replace(/^(\d{5})(\d{3})$/, "$1-$2") : "",
          cityId: ownVenue.cityId,
        }
      : BLANK.newVenue,
    onlineUrl: has(2) ? (event.onlineUrl ?? "") : "",
    capacity: has(3) ? String(event.capacity) : "",
    halfPriceQuotaPercent: has(3) && event.halfPriceQuotaBps !== null ? String(event.halfPriceQuotaBps / 100) : "",
    maxTicketsPerAccount: has(3) && event.maxTicketsPerAccount !== null ? String(event.maxTicketsPerAccount) : "",
    // Sem a etapa 3, o período provisório (agora → início do evento) vira sugestão.
    salesStartLocal: has(2) ? local(event.salesStartAt) : "",
    salesEndLocal: has(2) ? local(event.salesEndAt) : "",
    description: event.description,
    coverImageUrl: event.coverImageUrl ?? "",
    ageRestriction: String(event.ageRestriction),
    accessibilityInfo: event.accessibilityInfo ?? "",
    refundPolicy: event.refundPolicy,
    transferDeadlineHours: String(event.transferDeadlineHours),
    transferMaxTransfers: String(event.transferMaxTransfers),
    transferAllowReturn: event.transferAllowReturn,
    refundWindowDays: String(event.refundWindowDays),
    refundMinHoursBeforeEvent: String(event.refundMinHoursBeforeEvent),
  };

  // Estimativa por ingresso com a regra de comissão vigente (mesmo cálculo do pedido).
  const rule = await resolveCommissionRule(db, org.id, event.id).catch(() => null);
  const estimates: Record<string, WizardEstimate> = {};
  if (rule) {
    for (const t of event.ticketTypes) {
      if (t.priceCents === 0) continue;
      const f = computeFees([{ ticketTypeId: t.id, unitPriceCents: t.priceCents, quantity: 1 }], rule);
      estimates[t.id] = {
        buyerPaysCents: f.totalCents,
        organizerGetsCents: f.organizerShareCents,
        bearer: rule.bearer,
      };
    }
  }

  return (
    <>
      <PageTitle title={event.title} subtitle="Cadastro do evento em 6 etapas. Tudo é salvo automaticamente como rascunho." />
      {/* Mesma posição do ramo sem evento: o assistente não é remontado ao criar o rascunho. */}
      {null}
      <EventWizard
        {...common}
        eventId={event.id}
        step={step}
        completed={completed}
        initial={initial}
        estimates={estimates}
        ticketTypes={event.ticketTypes.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
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
          isHidden: t.isHidden,
        }))}
      />
    </>
  );
}
