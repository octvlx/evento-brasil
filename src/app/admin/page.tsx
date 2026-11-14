import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Alert, Skeleton } from "@/components/ui/primitives";
import { PageTitle, StatCard } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { adminQueueCounts } from "@/server/services/admin-oversight";
import { adminStats } from "@/server/services/reports";
import { alertRecipients, operationalHealth } from "@/server/services/ops-health";
import { formatDateTimeShort } from "@/lib/datetime";
import { ADMIN_ROLE_LABELS } from "@/server/auth/admin-roles";
import { formatBRL } from "@/lib/money";

export const metadata: Metadata = { title: "Administração", robots: { index: false } };

export default function AdminHome({ searchParams }: PageProps<"/admin">) {
  return (
    <Suspense fallback={<Skeleton className="h-[500px]" />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: PageProps<"/admin">["searchParams"] }) {
  const admin = await requireAdmin();
  const { semPermissao } = await searchParams;
  const roles = admin.adminRoles.map((r) => ADMIN_ROLE_LABELS[r].name).join(", ");
  const [s, q, health] = await Promise.all([adminStats(db, admin), adminQueueCounts(db, admin), operationalHealth(db)]);
  const paidOrders = (s.orders.PAID ?? 0) + (s.orders.REFUNDED ?? 0) + (s.orders.REFUND_PENDING ?? 0) + (s.orders.DISPUTED ?? 0);
  return (
    <>
      <PageTitle title="Visão geral do marketplace" subtitle="Valores do razão interno e dos pedidos." />
      {semPermissao && (
        <Alert variant="warning" className="mb-4" role="alert">
          Seu papel de administrador não dá acesso àquela área. Peça a um super admin se precisar.
        </Alert>
      )}
      <p className="mb-4 text-sm text-muted-foreground" data-testid="admin-roles">
        Seu papel: <strong>{roles || "nenhum (só a visão geral)"}</strong>
      </p>
      {health.length > 0 ? (
        <Alert variant={health.some((c) => c.severity === "critical") ? "danger" : "warning"} className="mb-4" data-testid="ops-health">
          <p className="font-semibold">Precisa de atenção</p>
          <ul className="mt-1 space-y-1">
            {health.map((c) => (
              <li key={c.code}>
                <Link href={c.href} className="underline">
                  {c.title}
                </Link>
                : {c.count}
                {c.oldestAt && <span className="text-xs"> (desde {formatDateTimeShort(c.oldestAt)})</span>}
              </li>
            ))}
          </ul>
          {alertRecipients().length === 0 && <p className="mt-2 text-xs">Alertas por e-mail desligados: defina ALERT_EMAILS no ambiente para recebê-los.</p>}
        </Alert>
      ) : (
        <p className="mb-4 text-sm text-success" data-testid="ops-health">Nenhum problema operacional pendente (webhooks, reembolsos, e-mails).</p>
      )}
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
        <Link href="/admin/cancelamentos" className="rounded-2xl border border-border bg-card p-5 hover:border-secondary">
          <p className="text-sm text-muted-foreground">Pedidos de cancelamento</p>
          <p className="font-display text-3xl font-extrabold">{q.openCancellations}</p>
          <p className="text-sm">
            em análise{q.overdueCancellations > 0 && <strong className="text-destructive"> · {q.overdueCancellations} com prazo vencido</strong>}
          </p>
        </Link>
        <Link href="/admin/pagamentos#reembolsos-falhos" className="rounded-2xl border border-border bg-card p-5 hover:border-secondary">
          <p className="text-sm text-muted-foreground">Reembolsos com falha</p>
          <p className="font-display text-3xl font-extrabold">{q.failedRefunds}</p>
          <p className="text-sm">aguardando nova tentativa ou decisão</p>
        </Link>
      </div>
    </>
  );
}
