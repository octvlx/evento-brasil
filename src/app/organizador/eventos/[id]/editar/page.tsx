import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ExternalLink, QrCode, Users } from "lucide-react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { EventForm } from "@/features/organizer/event-form";
import { EventStatusActions } from "@/features/organizer/event-status-actions";
import { TicketTypesManager } from "@/features/organizer/ticket-types-manager";
import { CouponsManager } from "@/features/organizer/coupons-manager";
import { TrackingLinksManager } from "@/features/organizer/tracking-links-manager";
import { eventFormOptions } from "@/features/organizer/form-data";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { listEventCoupons } from "@/server/services/coupons";
import { listEventTrackingLinks } from "@/server/services/tracking-links";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { utcToZonedLocalInput } from "@/lib/datetime";
import { EVENT_STATUS } from "@/lib/labels";

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
  const options = await eventFormOptions(db, org.id);
  const paidOrders = await db.order.count({ where: { eventId: id, status: "PAID" } });
  const tz = event.timezone;
  const locked = !["DRAFT", "PENDING_REVIEW", "PUBLISHED"].includes(event.status) || !can("event:write");
  const st = EVENT_STATUS[event.status];
  const canWrite = can("event:write");
  const [coupons, links] = canWrite ? await Promise.all([listEventCoupons(db, user, id), listEventTrackingLinks(db, user, id)]) : [[], []];

  return (
    <>
      <PageTitle
        title={event.title}
        subtitle={undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {event.status === "PUBLISHED" && (
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

      <Card className="mb-6 p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Publicação</h2>
        <EventStatusActions eventId={event.id} status={event.status} canPublish={can("event:publish")} canCancel={can("event:cancel")} paidOrders={paidOrders} />
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

      <Card className="p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Dados do evento</h2>
        <EventForm
          eventId={event.id}
          {...options}
          locked={locked}
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
            halfPriceQuotaPercent: event.halfPriceQuotaBps === null ? undefined : event.halfPriceQuotaBps / 100,
            refundPolicy: event.refundPolicy,
            accessibilityInfo: event.accessibilityInfo ?? undefined,
            coverImageUrl: event.coverImageUrl ?? undefined,
          }}
        />
      </Card>
    </>
  );
}
