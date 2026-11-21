import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { EventAdminActions } from "@/features/admin/entity-actions";
import { HistoryTable, auditLinkFor } from "@/features/admin/history-table";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { adminHas } from "@/server/auth/admin-roles";
import { entityHistory, parsePage } from "@/server/services/admin-oversight";
import { formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";
import { effectiveEventStatus } from "@/lib/event-lifecycle";
import { EVENT_STATUS, ORDER_STATUS, toneToBadge } from "@/lib/labels";
import { formatBRL } from "@/lib/money";

export const metadata: Metadata = { title: "Evento — admin", robots: { index: false } };

type Search = { historico?: string };

export default function AdminEventDetail({ params, searchParams }: PageProps<"/admin/eventos/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content params={params} searchParams={searchParams as Promise<Search>} />
    </Suspense>
  );
}

async function Content({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const admin = await requireAdmin("events:moderate");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const event = await db.event.findUnique({
    where: { id },
    include: {
      organization: { select: { id: true, name: true } },
      category: { select: { name: true } },
      city: true,
      venue: { include: { city: true } },
      ticketTypes: { select: { id: true, name: true, priceCents: true, quantityTotal: true, quantitySold: true, quantityReserved: true, quantityRefunded: true }, orderBy: { sortOrder: "asc" } },
    },
  });
  if (!event) notFound();
  // Sem valores: a moderação (events:moderate) não tem acesso ao financeiro; só contagens.
  const [history, orderStats] = await Promise.all([
    entityHistory(db, admin, "Event", event.id, parsePage(sp.historico)),
    db.order.groupBy({ by: ["status"], where: { eventId: event.id }, _count: { _all: true } }),
  ]);
  const status = effectiveEventStatus(event);
  const st = EVENT_STATUS[status];
  const city = event.venue?.city ?? event.city;
  const sold = event.ticketTypes.reduce((s, t) => s + t.quantitySold, 0);
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/admin/eventos" className="text-secondary hover:underline">
          ← Eventos
        </Link>
      </p>
      <PageTitle title={event.title} subtitle={`${event.category.name} · ${formatEventDateTime(event.startsAt, event.timezone)}`} />
      <Card className="mb-6 space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 text-sm">
            <p>
              <Badge variant={toneToBadge[st.tone]}>{st.label}</Badge> {event.isFeatured && <Badge variant="accent">Destaque</Badge>} {event.suspendedAt && <Badge variant="danger">Suspenso</Badge>}
            </p>
            {event.suspendedAt && <p className="text-xs text-destructive">Suspenso em {formatDateTimeShort(event.suspendedAt)}: {event.suspensionReason}</p>}
            <p>
              Organização:{" "}
              <Link href={`/admin/organizadores/${event.organization.id}`} className="font-semibold text-secondary hover:underline">
                {event.organization.name}
              </Link>
            </p>
            <p className="text-muted-foreground">
              {event.locationType === "ONLINE" ? "Online" : `${event.venue?.name ?? "Local a definir"}${city ? ` · ${city.name} – ${city.state}` : ""}`} · capacidade {event.capacity} · {sold} vendidos
            </p>
            <p className="text-muted-foreground">
              Pedidos: {orderStats.length ? orderStats.map((o) => `${o._count._all} ${ORDER_STATUS[o.status].label.toLowerCase()}`).join(" · ") : "nenhum"} · criado em {formatDateTimeShort(event.createdAt)}
            </p>
            {(status === "PUBLISHED" || status === "COMPLETED") && (
              <p>
                <Link href={`/eventos/${event.slug}`} target="_blank" className="text-secondary hover:underline">
                  Ver página pública
                </Link>
              </p>
            )}
          </div>
          <EventAdminActions e={{ id: event.id, status, rawStatus: event.status, suspendedAt: event.suspendedAt, isFeatured: event.isFeatured }} />
        </div>
      </Card>

      <div className="mb-6">
        <section aria-labelledby="tickets-title">
          <h2 id="tickets-title" className="mb-2 text-sm font-bold">
            Ingressos
          </h2>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-sm">
            {event.ticketTypes.length === 0 && <li className="p-3 text-muted-foreground">Nenhum tipo de ingresso.</li>}
            {event.ticketTypes.map((t) => (
              <li key={t.id} className="flex flex-wrap justify-between gap-2 p-3">
                <span className="font-semibold">{t.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t.priceCents ? formatBRL(t.priceCents) : "Gratuito"} · {t.quantitySold}/{t.quantityTotal} vendidos · {t.quantityReserved} reservados · {t.quantityRefunded} reembolsados
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <HistoryTable history={history} path={`/admin/eventos/${event.id}`} auditHref={adminHas(admin.adminRoles, "audit:read") ? auditLinkFor("Event", event.id) : undefined} />
    </>
  );
}
