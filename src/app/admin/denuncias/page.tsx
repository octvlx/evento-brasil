import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Badge, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { AdminActionButton } from "@/features/admin/controls";
import { decideEventReportsAction, suspendEventAction } from "@/features/admin/actions";
import { Pager } from "@/features/admin/pager";
import { EVENT_REPORT_REASONS } from "@/features/event-reports/labels";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { parsePage } from "@/server/services/admin-oversight";
import { listOpenEventReports } from "@/server/services/event-reports";
import { formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";

export const metadata: Metadata = { title: "Denúncias de eventos — admin", robots: { index: false } };

type Search = { pagina?: string };

export default function AdminEventReports({ searchParams }: PageProps<"/admin/denuncias">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<Search>} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin("events:moderate");
  const sp = await searchParams;
  const queue = await listOpenEventReports(db, admin, parsePage(sp.pagina));
  return (
    <>
      <PageTitle
        title="Denúncias de eventos"
        subtitle="Eventos com denúncias abertas, os mais denunciados primeiro. A decisão vale para as denúncias mostradas aqui (as que chegarem depois continuam abertas); suspender ou cancelar continua nas ações do evento."
      />
      {queue.items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-8 text-center text-muted-foreground" data-testid="reports-empty">
          Nenhuma denúncia aberta.
        </p>
      ) : (
        <ul className="space-y-4">
          {queue.items.map(({ event, count, oldestAt, reports }) => (
            <li key={event.id}>
              <Card className="space-y-3 p-4" data-testid="report-group">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      <Link href={`/eventos/${event.slug}`} className="hover:underline" target="_blank">
                        {event.title}
                      </Link>{" "}
                      <Badge variant="danger">
                        {count} {count === 1 ? "denúncia" : "denúncias"}
                      </Badge>{" "}
                      {event.suspendedAt && <Badge variant="warning">Suspenso</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {event.organization.name} · {formatEventDateTime(event.startsAt, event.timezone)} · primeira denúncia em {formatDateTimeShort(oldestAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <AdminActionButton
                      label="Procedente"
                      variant="secondary"
                      askReason="O que foi feito (obrigatório)"
                      reasonRequired
                      action={decideEventReportsAction.bind(null, event.id, "RESOLVED", reports.map((r) => r.id))}
                    />
                    <AdminActionButton label="Descartar" askReason="Motivo (opcional)" action={decideEventReportsAction.bind(null, event.id, "DISMISSED", reports.map((r) => r.id))} />
                    {event.status === "PUBLISHED" && !event.suspendedAt && (
                      <AdminActionButton
                        label="Suspender evento"
                        variant="destructive"
                        askReason="Motivo da suspensão"
                        reasonRequired
                        confirm="Tira o evento da vitrine e pausa as vendas, sem cancelar nem reembolsar. Depois, marque as denúncias como procedentes."
                        action={suspendEventAction.bind(null, event.id, true)}
                      />
                    )}
                  </div>
                </div>
                <ul className="divide-y divide-border rounded-xl border border-border text-sm">
                  {reports.map((r) => (
                    <li key={r.id} className="space-y-1 p-3">
                      <p>
                        <strong>{EVENT_REPORT_REASONS[r.reason]}</strong>
                        <span className="text-muted-foreground">
                          {" "}
                          · {r.reporter.name} · {formatDateTimeShort(r.createdAt)}
                        </span>
                      </p>
                      {r.details && <p className="whitespace-pre-line text-muted-foreground">{r.details}</p>}
                    </li>
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Pager path="/admin/denuncias" params={{}} page={queue.page} pageCount={queue.pageCount} total={queue.total} />
    </>
  );
}
