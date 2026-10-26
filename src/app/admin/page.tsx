import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Alert, Skeleton } from "@/components/ui/primitives";
import { PageTitle, StatCard } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { adminStats } from "@/server/services/reports";
import { formatBRL } from "@/lib/money";

export const metadata: Metadata = { title: "Administração", robots: { index: false } };

export default function AdminHome() {
  return (
    <Suspense fallback={<Skeleton className="h-[500px]" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const admin = await requireAdmin();
  const s = await adminStats(db, admin);
  const paidOrders = (s.orders.PAID ?? 0) + (s.orders.REFUNDED ?? 0) + (s.orders.REFUND_PENDING ?? 0) + (s.orders.DISPUTED ?? 0);
  return (
    <>
      <PageTitle title="Visão geral do marketplace" subtitle="Valores do razão interno e dos pedidos." />
      {s.balances.includesSimulated && <Alert variant="warning" className="mb-4">Os totais incluem pagamentos simulados de desenvolvimento.</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Vendas brutas (GMV)" value={formatBRL(s.balances.grossCents)} />
        <StatCard label="Receita da plataforma" value={formatBRL(s.balances.platformFeeCents)} hint="Comissão + taxa de serviço, líquidas de estornos" />
        <StatCard label="Reembolsos" value={formatBRL(s.balances.refundCents)} hint={`${s.refunds.SUCCEEDED ?? 0} concluídos · ${s.refunds.FAILED ?? 0} com falha`} />
        <StatCard label="Chargebacks" value={formatBRL(s.balances.chargebackCents)} />
        <StatCard label="Pedidos pagos" value={String(paidOrders)} hint={`${s.orders.PENDING_PAYMENT ?? 0} aguardando pagamento`} />
        <StatCard label="Usuários" value={String(s.users)} />
        <StatCard label="Eventos publicados" value={String(s.events.PUBLISHED ?? 0)} />
        <StatCard label="Webhooks não processados" value={String(s.webhooksPending)} />
      </div>
      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Link href="/admin/organizadores" className="rounded-2xl border border-border bg-card p-5 hover:border-secondary">
          <p className="text-sm text-muted-foreground">Fila de aprovação</p>
          <p className="font-display text-3xl font-extrabold">{s.orgs.PENDING_REVIEW ?? 0}</p>
          <p className="text-sm">organizadores aguardando análise</p>
        </Link>
        <Link href="/admin/eventos" className="rounded-2xl border border-border bg-card p-5 hover:border-secondary">
          <p className="text-sm text-muted-foreground">Fila de moderação</p>
          <p className="font-display text-3xl font-extrabold">{s.events.PENDING_REVIEW ?? 0}</p>
          <p className="text-sm">eventos aguardando moderação</p>
        </Link>
      </div>
    </>
  );
}
