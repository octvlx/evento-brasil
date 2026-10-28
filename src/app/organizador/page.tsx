import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BarChart3, CalendarPlus, ChevronRight, QrCode, UserPlus, Users } from "lucide-react";
import { Alert, Badge, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, StatCard } from "@/components/site/panel-shell";
import { SalesChart } from "@/components/site/sales-chart";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { dailySales, organizerDashboard, organizerFinancials, organizerOverview } from "@/server/services/reports";
import { formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { EVENT_STATUS, ORDER_STATUS, ORG_STATUS, PAYMENT_ACCOUNT_STATUS, toneToBadge } from "@/lib/labels";

export const metadata: Metadata = { title: "Painel do organizador", robots: { index: false } };

export default function OrganizerDashboard() {
  return (
    <Suspense fallback={<Skeleton className="h-[520px]" />}>
      <Content />
    </Suspense>
  );
}

const pct = (part: number, total: number) => (total > 0 ? Math.min(100, Math.round((part / total) * 100)) : 0);

async function Content() {
  const { user, org, can } = await requireOrganizer();
  // Cada serviço verifica a permissão do papel no servidor; a tela só decide o que mostrar.
  const [overview, dash] = await Promise.all([organizerOverview(db, user, org.id), organizerDashboard(db, user, org.id)]);
  const fin = can("finance:read") ? await organizerFinancials(db, user, org.id) : null;
  const daily = can("finance:read") ? await dailySales(db, user, org.id, 30) : null;
  const st = ORG_STATUS[org.status];

  const quickActions = [
    can("event:write") && { href: "/organizador/eventos/novo", label: "Criar evento", icon: CalendarPlus },
    can("members:manage") && { href: "/organizador/equipe", label: "Convidar equipe", icon: UserPlus },
    can("finance:read") && { href: "/organizador/vendas", label: "Vendas e repasses", icon: BarChart3 },
    can("attendees:read") && { href: "/organizador/participantes", label: "Participantes", icon: Users },
    can("checkin:scan") && { href: "/check-in", label: "Check-in", icon: QrCode },
  ].filter(Boolean) as { href: string; label: string; icon: typeof CalendarPlus }[];

  return (
    <>
      <PageTitle
        title={org.name}
        subtitle={`Cadastro: ${st.label} · Conta de recebimento: ${PAYMENT_ACCOUNT_STATUS[org.paymentAccountStatus]}`}
        actions={
          can("event:write") && (
            <Link href="/organizador/eventos/novo" className={buttonVariants({ variant: "accent" })}>
              <CalendarPlus aria-hidden /> Criar evento
            </Link>
          )
        }
      />

      {dash.alerts.length > 0 && (
        <section aria-label="Pendências" className="mb-6 space-y-2">
          {dash.alerts.map((a, i) => (
            <Alert key={i} variant={a.tone === "danger" ? "danger" : a.tone === "warning" ? "warning" : "info"} className="flex items-center justify-between gap-3">
              <span>{a.text}</span>
              {a.href && (
                <Link href={a.href} className="flex shrink-0 items-center gap-0.5 font-semibold underline-offset-2 hover:underline">
                  Resolver <ChevronRight className="size-4" aria-hidden />
                </Link>
              )}
            </Alert>
          ))}
        </section>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Eventos" value={String(overview.totalEvents)} hint={`${overview.publishedEvents} publicados · ${dash.pastCount} encerrados`} />
        <StatCard label="Ingressos vendidos" value={String(overview.ticketsSold)} hint={`${overview.ticketsRevoked} cancelados/reembolsados`} />
        <StatCard label="Check-ins" value={String(overview.attendance)} hint={overview.ticketsSold ? `${pct(overview.attendance, overview.ticketsSold)}% de presença` : undefined} />
        {fin && <StatCard label="Vendas brutas" value={formatBRL(fin.grossCents)} />}
      </div>

      {fin && (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Reembolsos" value={formatBRL(fin.refundCents + fin.chargebackCents)} />
            <StatCard label="Taxas da plataforma" value={formatBRL(fin.platformFeeCents)} hint="Comissão líquida de estornos" />
            <StatCard label="Custos de processamento" value={formatBRL(fin.processingFeeCents)} />
            <StatCard label="Receita líquida estimada" value={formatBRL(fin.organizerNetCents)} hint="Antes de liquidação pelo provedor" />
          </div>
          {fin.includesSimulated && <p className="mt-2 text-xs text-warning">Inclui valores de pagamentos simulados (ambiente de desenvolvimento).</p>}
        </>
      )}

      {quickActions.length > 0 && (
        <nav aria-label="Ações rápidas" className="mt-6 flex flex-wrap gap-2">
          {quickActions.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Icon aria-hidden /> {label}
            </Link>
          ))}
        </nav>
      )}

      <section className="mt-8">
        <div className="mb-3 flex items-end justify-between">
          <h2 className="font-display text-lg font-bold">Próximos eventos</h2>
          <Link href="/organizador/eventos" className="text-sm font-semibold text-secondary hover:underline">
            Ver todos
          </Link>
        </div>
        {dash.upcomingEvents.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Nenhum evento futuro. {can("event:write") && <Link href="/organizador/eventos/novo" className="font-semibold text-secondary underline">Crie o primeiro</Link>}
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
            {dash.upcomingEvents.map((e) => {
              const es = EVENT_STATUS[e.status];
              const sold = pct(e.sold, e.capacity);
              return (
                <li key={e.id} className="grid gap-2 p-4 sm:grid-cols-[1fr_200px_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{e.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatEventDateTime(e.startsAt, e.timezone)} · <Badge variant={toneToBadge[es.tone]}>{es.label}</Badge>
                    </p>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>
                        {e.sold}/{e.capacity} vendidos
                      </span>
                      <span>{e.checkedIn} check-ins</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={sold} aria-valuemin={0} aria-valuemax={100} aria-label={`${sold}% vendido`}>
                      <div className="h-full rounded-full bg-secondary" style={{ width: `${sold}%` }} />
                    </div>
                  </div>
                  {can("event:write") ? (
                    <Link href={`/organizador/eventos/${e.id}/editar`} className="text-sm font-semibold text-secondary hover:underline">
                      Gerenciar
                    </Link>
                  ) : (
                    <span />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {dash.eventPerformance && dash.eventPerformance.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-display text-lg font-bold">Desempenho por evento</h2>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Evento</th>
                  <th className="p-3 text-right">Ocupação</th>
                  <th className="p-3 text-right">Vendas brutas</th>
                  <th className="p-3 text-right">Reembolsos</th>
                </tr>
              </thead>
              <tbody>
                {dash.eventPerformance.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="p-3">
                      {e.title} {e.status !== "PUBLISHED" && <span className="text-xs text-muted-foreground">({EVENT_STATUS[e.status].label})</span>}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {e.sold}/{e.capacity} ({pct(e.sold, e.capacity)}%)
                    </td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(e.grossCents)}</td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(e.refundCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {fin && (
        <section className="mt-8 rounded-2xl border border-border bg-card p-5">
          <h2 className="mb-4 font-display text-lg font-bold">Vendas pagas nos últimos 30 dias</h2>
          <SalesChart data={daily ?? []} />
        </section>
      )}

      {dash.recentOrders && (
        <section className="mt-8">
          <div className="mb-3 flex items-end justify-between">
            <h2 className="font-display text-lg font-bold">Pedidos recentes</h2>
            <Link href="/organizador/vendas" className="text-sm font-semibold text-secondary hover:underline">
              Ver todas as vendas
            </Link>
          </div>
          {dash.recentOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum pedido pago ainda.</p>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-sm">
              {dash.recentOrders.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                  <span className="min-w-0">
                    <span className="font-mono text-xs text-muted-foreground">{o.publicCode}</span> · {o.buyerName} · <span className="text-muted-foreground">{o.event.title}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{o.paidAt ? formatDateTimeShort(o.paidAt) : ""}</span>
                    <span className="tabular-nums font-semibold">{formatBRL(o.totalCents)}</span>
                    <Badge variant={toneToBadge[ORDER_STATUS[o.status].tone]}>{ORDER_STATUS[o.status].label}</Badge>
                    {o.isSimulated && <Badge variant="warning">simulado</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
