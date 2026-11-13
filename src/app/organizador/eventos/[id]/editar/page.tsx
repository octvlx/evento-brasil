import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { BarChart3, ExternalLink, QrCode, Users } from "lucide-react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { EventForm } from "@/features/organizer/event-form";
import { EventChangesHistory } from "@/features/organizer/event-changes-history";
import { refundRequestsText, type ChangeSnapshotJson } from "@/features/organizer/event-change-rules";
import { EventStatusActions } from "@/features/organizer/event-status-actions";
import { TicketTypesManager } from "@/features/organizer/ticket-types-manager";
import { CouponsManager } from "@/features/organizer/coupons-manager";
import { TrackingLinksManager } from "@/features/organizer/tracking-links-manager";
import { eventFormOptions } from "@/features/organizer/form-data";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { listEventCoupons } from "@/server/services/coupons";
import { halfPriceControl } from "@/server/services/reports";
import { HalfPriceControl } from "@/features/organizer/half-price-control";
import { limitPercentForForm } from "@/features/half-price/policy";
import { listEventChanges } from "@/server/services/event-changes";
import { listEventTrackingLinks } from "@/server/services/tracking-links";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { getWizardProgress, isWizardComplete } from "@/server/services/event-wizard-progress";
import { firstIncompleteStep } from "@/features/organizer/wizard-steps";
import { formatDateTimeShort, utcToZonedLocalInput } from "@/lib/datetime";
import { EVENT_STATUS } from "@/lib/labels";
import { effectiveEventStatus } from "@/lib/event-lifecycle";

export const metadata: Metadata = { title: "Gerenciar evento", robots: { index: false } };

export default function EditEventPage({ params }: PageProps<"/organizador/eventos/[id]/editar">) {
  return (
    <Suspense fallback={<Skeleton className="h-[800px]" />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, org, can } = await requireOrganizer(`/organizador/eventos/${id}/editar`);
  // Escopo por organização: evento de outra organização → 404.
  const event = await db.event.findFirst({ where: { id, organizationId: org.id }, include: { ticketTypes: { orderBy: { sortOrder: "asc" } } } });
  if (!event) notFound();
  // Rascunho do assistente com etapas pendentes: continua o cadastro guiado.
  if (event.status === "DRAFT" && can("event:write")) {
    const progress = await getWizardProgress(db, id);
    if (!isWizardComplete(progress)) redirect(`/organizador/eventos/novo?evento=${id}&etapa=${firstIncompleteStep(progress.completed)}`);
  }
  const options = await eventFormOptions(db, org.id);
  const paidOrders = await db.order.count({ where: { eventId: id, status: "PAID" } });
  const tz = event.timezone;
  // Status efetivo: terminado conta como encerrado (sem edição), mesmo antes do job.
  const status = effectiveEventStatus(event);
  const locked = !["DRAFT", "PENDING_REVIEW", "PUBLISHED"].includes(status) || !can("event:write");
  const st = EVENT_STATUS[status];
  const canWrite = can("event:write");
  const changes = await listEventChanges(db, user, id);
  const openWindows = changes.filter((c) => c.windowOpen);
  // Controle de meia-entrada: mesma permissão dos relatórios do evento (finance:read).
  const halfControl = can("finance:read") ? await halfPriceControl(db, user, id) : null;
  const [coupons, links] = canWrite ? await Promise.all([listEventCoupons(db, user, id), listEventTrackingLinks(db, user, id)]) : [[], []];

  return (
    <>
      <PageTitle
        title={event.title}
        subtitle={undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/organizador/eventos/${event.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <BarChart3 aria-hidden /> Resumo
            </Link>
            {(status === "PUBLISHED" || status === "COMPLETED") && (
              <Link href={`/eventos/${event.slug}`} className={buttonVariants({ variant: "outline", size: "sm" })} target="_blank">
                <ExternalLink aria-hidden /> Ver página
              </Link>
            )}
            <Link href={`/organizador/participantes?evento=${event.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Users aria-hidden /> Participantes
            </Link>
            <Link href={`/check-in/${event.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <QrCode aria-hidden /> Check-in
            </Link>
          </div>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge variant={st.tone === "success" ? "success" : st.tone === "warning" ? "warning" : st.tone === "danger" ? "danger" : "default"}>{st.label}</Badge>
        {event.moderationNote && <span className="text-sm text-destructive">Moderação: {event.moderationNote}</span>}
      </div>
      {event.status === "PENDING_REVIEW" && <Alert variant="warning" className="mb-6">Aguardando moderação da plataforma.</Alert>}
      {event.status === "CANCELLED" && <Alert variant="danger" className="mb-6">Evento cancelado: {event.cancellationReason}</Alert>}
      {openWindows.length > 0 && (
        <Alert variant="warning" className="mb-6">
          <p className="font-semibold">Janelas de reembolso por alteração abertas</p>
          <ul className="mt-1 space-y-1">
            {openWindows.map((c) => (
              <li key={c.id}>
                Alteração de {formatDateTimeShort(c.createdAt, tz)}: reembolso integral até {formatDateTimeShort(c.effectiveRefundUntil!, tz)}. {c.refundRequests && refundRequestsText(c.refundRequests)}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Card className="mb-6 p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Publicação</h2>
        <EventStatusActions eventId={event.id} status={status} canPublish={can("event:publish")} canCancel={can("event:cancel")} paidOrders={paidOrders} />
      </Card>

      <Card className="mb-6 p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Ingressos</h2>
        <TicketTypesManager
          eventId={event.id}
          locked={locked}
          items={event.ticketTypes.map((t) => ({
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
            salesStartLocal: t.salesStartAt ? utcToZonedLocalInput(t.salesStartAt, tz) : "",
            salesEndLocal: t.salesEndAt ? utcToZonedLocalInput(t.salesEndAt, tz) : "",
            requiresAttendeeInfo: t.requiresAttendeeInfo,
            isHidden: t.isHidden,
          }))}
        />
      </Card>

      {halfControl && (
        <Card className="mb-6 p-6">
          <HalfPriceControl control={halfControl} />
        </Card>
      )}

      {canWrite && (
        <>
          <Card className="mb-6 p-6">
            <h2 className="mb-4 font-display text-lg font-bold">Cupons de desconto</h2>
            <CouponsManager
              eventId={event.id}
              locked={locked}
              ticketTypes={event.ticketTypes.filter((t) => t.priceCents > 0 && t.kind !== "HALF_PRICE").map((t) => ({ id: t.id, name: t.name }))}
              items={coupons.map((c) => ({
                ...c,
                validFromLocal: c.validFrom ? utcToZonedLocalInput(c.validFrom, tz) : "",
                validUntilLocal: c.validUntil ? utcToZonedLocalInput(c.validUntil, tz) : "",
              }))}
            />
          </Card>

          <Card className="mb-6 p-6">
            <h2 className="mb-4 font-display text-lg font-bold">Links de divulgação</h2>
            <TrackingLinksManager
              eventId={event.id}
              locked={locked}
              coupons={coupons.filter((c) => !c.disabled).map((c) => ({ id: c.id, code: c.code }))}
              items={links.map((l) => ({ ...l, url: `${env().APP_URL}/r/${l.code}` }))}
            />
          </Card>
        </>
      )}

      <Card className="mb-6 p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Histórico de alterações</h2>
        <EventChangesHistory
          timezone={tz}
          canExtend={canWrite && !locked}
          maxLocal={utcToZonedLocalInput(event.startsAt, tz)}
          items={changes.map((c) => ({
            ...c,
            before: c.before as ChangeSnapshotJson,
            after: c.after as ChangeSnapshotJson,
            createdAt: c.createdAt.toISOString(),
            refundUntil: c.refundUntil?.toISOString() ?? null,
            effectiveRefundUntil: c.effectiveRefundUntil?.toISOString() ?? null,
            effectiveRefundUntilLocal: c.effectiveRefundUntil ? utcToZonedLocalInput(c.effectiveRefundUntil, tz) : null,
          }))}
        />
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Dados do evento</h2>
        <EventForm
          eventId={event.id}
          {...options}
          locked={locked}
          relevantGuard={
            event.status === "PUBLISHED" && paidOrders > 0
              ? { startsAtLocal: utcToZonedLocalInput(event.startsAt, tz), timezone: tz, locationType: event.locationType, venueId: event.venueId }
              : null
          }
          defaults={{
            title: event.title,
            summary: event.summary ?? undefined,
            description: event.description,
            categoryId: event.categoryId,
            locationType: event.locationType,
            venueId: event.venueId ?? undefined,
            onlineUrl: event.onlineUrl ?? undefined,
            cityId: event.cityId ?? undefined,
            timezone: tz as never,
            startsAtLocal: utcToZonedLocalInput(event.startsAt, tz),
            endsAtLocal: utcToZonedLocalInput(event.endsAt, tz),
            salesStartLocal: utcToZonedLocalInput(event.salesStartAt, tz),
            salesEndLocal: utcToZonedLocalInput(event.salesEndAt, tz),
            ageRestriction: event.ageRestriction,
            capacity: event.capacity,
            halfPriceQuotaPercent: limitPercentForForm(event.halfPriceQuotaBps) ?? undefined,
            maxTicketsPerAccount: event.maxTicketsPerAccount ?? undefined,
            refundPolicy: event.refundPolicy,
            transferDeadlineHours: event.transferDeadlineHours,
            transferMaxTransfers: event.transferMaxTransfers,
            transferAllowReturn: event.transferAllowReturn,
            refundWindowDays: event.refundWindowDays,
            refundMinHoursBeforeEvent: event.refundMinHoursBeforeEvent,
            accessibilityInfo: event.accessibilityInfo ?? undefined,
            coverImageUrl: event.coverImageUrl ?? undefined,
          }}
        />
      </Card>
    </>
  );
}
