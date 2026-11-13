import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BarChart3, ExternalLink, Pencil, QrCode, Users } from "lucide-react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, StatCard } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { eventSalesSummary, salesReport } from "@/server/services/reports";
import { SalesReportView } from "@/features/reports/sales-report-view";
import { formatEventDateTime } from "@/lib/datetime";
import { EVENT_STATUS, TICKET_KIND } from "@/lib/labels";
import { effectiveEventStatus } from "@/lib/event-lifecycle";
import { formatBRL } from "@/lib/money";

export const metadata: Metadata = { title: "Resumo do evento", robots: { index: false } };

export default function EventOverviewPage({ params }: PageProps<"/organizador/eventos/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-[600px]" />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, org, can } = await requireOrganizer(`/organizador/eventos/${id}`);
  // Escopo por organização: evento de outra organização → 404.
  const event = await db.event.findFirst({
    where: { id, organizationId: org.id },
    include: { ticketTypes: { orderBy: { sortOrder: "asc" } }, venue: { include: { city: true } }, city: true },
  });
  if (!event) notFound();
  const status = effectiveEventStatus(event);
  const st = EVENT_STATUS[status];
  const canFinance = can("finance:read");
  const [checkedIn, validTickets, summary, report] = await Promise.all([
    db.issuedTicket.count({ where: { eventId: id, status: "CHECKED_IN" } }),
    db.issuedTicket.count({ where: { eventId: id, status: "VALID" } }),
    canFinance ? eventSalesSummary(db, user, id) : null,
    canFinance ? salesReport(db, user, org.id, { eventId: id, period: { from: null, to: null } }) : null,
  ]);
  const sold = event.ticketTypes.reduce((s, t) => s + t.quantitySold, 0);
  const reserved = event.ticketTypes.reduce((s, t) => s + t.quantityReserved, 0);
  const city = event.venue?.city ?? event.city;
  const place = event.locationType === "ONLINE" ? "Online" : [event.venue?.name, city && `${city.name} – ${city.state}`].filter(Boolean).join(", ");

  return (
    <>
      <PageTitle
        title={event.title}
        subtitle={`${formatEventDateTime(event.startsAt, event.timezone)} · ${place}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {can("event:write") && (
              <Link href={`/organizador/eventos/${id}/editar`} className={buttonVariants({ variant: "accent", size: "sm" })}>
                <Pencil aria-hidden /> Gerenciar
              </Link>
            )}
            {(status === "PUBLISHED" || status === "COMPLETED") && (
              <Link href={`/eventos/${event.slug}`} className={buttonVariants({ variant: "outline", size: "sm" })} target="_blank">
                <ExternalLink aria-hidden /> Ver página
              </Link>
            )}
            {can("attendees:read") && (
              <Link href={`/organizador/participantes?evento=${id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <Users aria-hidden /> Participantes
              </Link>
            )}
            <Link href={`/check-in/${id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <QrCode aria-hidden /> Check-in
            </Link>
          </div>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge variant={st.tone === "success" ? "success" : st.tone === "warning" ? "warning" : st.tone === "danger" ? "danger" : "default"}>{st.label}</Badge>
        {event.status === "CANCELLED" && <span className="text-sm text-destructive">Cancelado: {event.cancellationReason}</span>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Ingressos vendidos" value={`${sold} / ${event.capacity}`} hint={reserved ? `${reserved} reservado(s) aguardando pagamento` : undefined} />
        <StatCard label="Check-ins" value={String(checkedIn)} hint={`${validTickets} ingresso(s) válido(s) ainda sem check-in`} />
        {summary && <StatCard label="A receber (estimado)" value={formatBRL(summary.balances.organizerNetCents)} hint="Do razão financeiro, já sem taxas e reembolsos" />}
        {summary?.halfPrice.quota != null && <StatCard label="Meia-entrada" value={`${summary.halfPrice.used} / ${summary.halfPrice.quota}`} hint="Meias vendidas ou reservadas / cota legal" />}
      </div>
      {summary?.balances.includesSimulated && <Alert variant="warning" className="mt-4">Inclui pagamentos simulados de desenvolvimento — não há dinheiro real envolvido.</Alert>}

      <Card className="mt-6 p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Estoque por tipo de ingresso</h2>
        {event.ticketTypes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum tipo de ingresso cadastrado.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[600px] text-sm" data-testid="ticket-type-stock">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Tipo</th>
                  <th className="p-3 text-right">Preço</th>
                  <th className="p-3 text-right">Vendidos</th>
                  <th className="p-3 text-right">Reservados</th>
                  <th className="p-3 text-right">Reembolsados</th>
                  <th className="p-3 text-right">Disponíveis</th>
                  <th className="p-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {event.ticketTypes.map((t) => (
                  <tr key={t.id} className="border-t border-border">
                    <td className="p-3">
                      {t.name} {t.isHidden && <Badge>oculto</Badge>}
                      <span className="block text-xs text-muted-foreground">{TICKET_KIND[t.kind] ?? t.kind}</span>
                    </td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(t.priceCents)}</td>
                    <td className="p-3 text-right tabular-nums">{t.quantitySold}</td>
                    <td className="p-3 text-right tabular-nums">{t.quantityReserved}</td>
                    <td className="p-3 text-right tabular-nums">{t.quantityRefunded}</td>
                    <td className="p-3 text-right tabular-nums">{Math.max(0, t.quantityTotal - t.quantitySold - t.quantityReserved)}</td>
                    <td className="p-3 text-right tabular-nums">{t.quantityTotal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {report && (
        <Card className="mt-6 p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-bold">Vendas</h2>
            <Link href={`/organizador/vendas?evento=${id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <BarChart3 aria-hidden /> Filtrar por período e exportar
            </Link>
          </div>
          <SalesReportView report={report} showEvents={false} />
        </Card>
      )}
    </>
  );
}
