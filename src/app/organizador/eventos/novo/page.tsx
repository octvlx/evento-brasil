import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { EventWizard } from "@/features/organizer/event-wizard";
import { eventFormOptions } from "@/features/organizer/form-data";
import { BLANK_WIZARD_VALUES, clampStep, DATA_STEPS, firstIncompleteStep, WIZARD_STEPS } from "@/features/organizer/wizard-steps";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { getWizardProgress, isWizardComplete, wizardProgressByEvent } from "@/server/services/event-wizard-progress";
import { WIZARD_EVENT_INCLUDE, wizardPageData } from "@/server/services/event-wizard-page";
import { formatDateTimeShort } from "@/lib/datetime";

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

const BLANK = BLANK_WIZARD_VALUES;

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

  const event = await db.event.findFirst({ where: { id: sp.evento, organizationId: org.id }, include: WIZARD_EVENT_INCLUDE });
  if (!event) notFound();
  if (event.status !== "DRAFT") redirect(`/organizador/eventos/${event.id}/editar`);
  const progress = await getWizardProgress(db, event.id);
  // Rascunho criado fora do assistente: todos os dados já são reais.
  const completed = progress.tracked ? progress.completed : [...DATA_STEPS];
  const step = clampStep(Number(sp.etapa) || undefined, completed);
  const data = await wizardPageData(db, org.id, event, completed, options.venues.length > 0);

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
        initial={data.initial}
        estimates={data.estimates}
        gallery={data.gallery}
        ticketTypes={data.ticketTypes}
      />
    </>
  );
}
