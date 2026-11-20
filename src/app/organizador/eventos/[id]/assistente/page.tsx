import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { EventWizard } from "@/features/organizer/event-wizard";
import { eventFormOptions } from "@/features/organizer/form-data";
import { DATA_STEPS, firstIncompleteStep, type WizardStep } from "@/features/organizer/wizard-steps";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { getWizardProgress, isWizardComplete } from "@/server/services/event-wizard-progress";
import { WIZARD_EVENT_INCLUDE, wizardPageData } from "@/server/services/event-wizard-page";
import { effectiveEventStatus } from "@/lib/event-lifecycle";

export const metadata: Metadata = { title: "Editar pelo assistente", robots: { index: false } };

/** Edição de um evento existente pelo assistente (as mesmas 6 etapas do cadastro). */
export default function EditWithWizardPage({ params, searchParams }: PageProps<"/organizador/eventos/[id]/assistente">) {
  return (
    <Suspense fallback={<Skeleton className="h-[700px]" />}>
      <Content params={params} searchParams={searchParams as Promise<{ etapa?: string }>} />
    </Suspense>
  );
}

const EDITABLE = ["DRAFT", "PENDING_REVIEW", "PUBLISHED"];

async function Content({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ etapa?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { org, can } = await requireOrganizer(`/organizador/eventos/${id}/assistente`);
  if (!can("event:write")) redirect(`/organizador/eventos/${id}/editar`);
  const event = await db.event.findFirst({ where: { id, organizationId: org.id }, include: WIZARD_EVENT_INCLUDE });
  if (!event) notFound();
  // Rascunho com etapas pendentes: continua no cadastro guiado (com autosave).
  if (event.status === "DRAFT") {
    const progress = await getWizardProgress(db, id);
    if (!isWizardComplete(progress)) redirect(`/organizador/eventos/novo?evento=${id}&etapa=${firstIncompleteStep(progress.completed)}`);
  }
  // Encerrado, cancelado ou recusado: não há o que editar (a gestão mostra o motivo).
  if (!EDITABLE.includes(effectiveEventStatus(event))) redirect(`/organizador/eventos/${id}/editar`);

  const options = await eventFormOptions(db, org.id);
  const completed = [...DATA_STEPS];
  const data = await wizardPageData(db, org.id, event, completed, options.venues.length > 0);
  const n = Number(sp.etapa);
  const step = (Number.isInteger(n) && n >= 1 && n <= 6 ? n : 1) as WizardStep;

  return (
    <>
      <PageTitle title={event.title} subtitle="Edição pelo assistente. Nada é salvo sozinho: revise as etapas e toque em “Salvar alterações”." />
      {data.hasSales && (
        <Alert variant="warning" className="mx-auto mb-4 max-w-3xl">
          Este evento já tem ingressos vendidos. As mesmas regras da edição valem aqui: capacidade e políticas de reembolso e transferência só podem ficar mais favoráveis ao
          comprador, e mudança de data, horário ou local exige motivo e avisa os compradores.
        </Alert>
      )}
      <EventWizard
        {...options}
        organizationName={org.name}
        canPublish={can("event:publish")}
        orgApproved={org.status === "APPROVED"}
        autoPublish={false}
        mode="edit"
        hasSales={data.hasSales}
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
