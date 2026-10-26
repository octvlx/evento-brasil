import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Plus } from "lucide-react";
import { Alert, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, StatCard } from "@/components/site/panel-shell";
import { SalesChart } from "@/components/site/sales-chart";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { dailySales, organizerFinancials, organizerOverview } from "@/server/services/reports";
import { formatBRL } from "@/lib/money";
import { ORG_STATUS, PAYMENT_ACCOUNT_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Painel do organizador", robots: { index: false } };

export default function OrganizerDashboard() {
  return (
    <Suspense fallback={<Skeleton className="h-[520px]" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const { user, org, can } = await requireOrganizer();
  const overview = await organizerOverview(db, user, org.id);
  const fin = can("finance:read") ? await organizerFinancials(db, user, org.id) : null;
  const daily = can("finance:read") ? await dailySales(db, user, org.id, 30) : null;
  const st = ORG_STATUS[org.status];

  return (
    <>
      <PageTitle
        title={org.name}
        subtitle={`Cadastro: ${st.label} · Conta de recebimento: ${PAYMENT_ACCOUNT_STATUS[org.paymentAccountStatus]}`}
        actions={
          can("event:write") && (
            <Link href="/organizador/eventos/novo" className={buttonVariants({ variant: "accent" })}>
              <Plus aria-hidden /> Criar evento
            </Link>
          )
        }
      />
      {org.status === "PENDING_REVIEW" && <Alert variant="warning" className="mb-6">Seu cadastro está em análise. Você já pode criar rascunhos; a publicação é liberada após a aprovação.</Alert>}
      {org.status === "REJECTED" && (
        <Alert variant="danger" className="mb-6">
          Cadastro recusado. <Link href="/organizador/cadastro" className="underline">Revise e reenvie</Link>.
        </Alert>
      )}
      {org.status === "SUSPENDED" && <Alert variant="danger" className="mb-6">Organização suspensa pela plataforma. Fale com o suporte.</Alert>}
      {org.status === "APPROVED" && org.paymentAccountStatus === "NOT_CONNECTED" && (
        <Alert className="mb-6">
          Conecte sua conta de recebimento em <Link href="/organizador/configuracoes" className="font-semibold text-secondary underline">Configurações</Link> para vender ingressos pagos.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Eventos" value={String(overview.totalEvents)} hint={`${overview.publishedEvents} publicados`} />
        <StatCard label="Ingressos vendidos" value={String(overview.ticketsSold)} hint={`${overview.ticketsRevoked} cancelados/reembolsados`} />
        <StatCard label="Check-ins" value={String(overview.attendance)} hint={overview.ticketsSold ? `${Math.round((overview.attendance / overview.ticketsSold) * 100)}% de presença` : undefined} />
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
          <section className="mt-8 rounded-2xl border border-border bg-card p-5">
            <h2 className="mb-4 font-display text-lg font-bold">Vendas pagas nos últimos 30 dias</h2>
            <SalesChart data={daily ?? []} />
          </section>
        </>
      )}
    </>
  );
}
