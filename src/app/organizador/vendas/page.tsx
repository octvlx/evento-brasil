import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle, StatCard } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { organizerFinancials } from "@/server/services/reports";
import { formatDateShort, formatDateTimeShort } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { ORDER_STATUS, PAYMENT_ACCOUNT_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Vendas e repasses", robots: { index: false } };

export default function SalesPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[600px]" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const { user, org, can } = await requireOrganizer("/organizador/vendas");
  if (!can("finance:read")) redirect("/organizador");
  const fin = await organizerFinancials(db, user, org.id);
  const [orders, events] = await Promise.all([
    db.order.findMany({
      where: { organizationId: org.id, status: { notIn: ["PENDING_PAYMENT", "EXPIRED", "CANCELLED"] } },
      include: { event: { select: { title: true } }, payments: { select: { method: true, status: true, processingFeeCents: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.event.findMany({
      where: { organizationId: org.id },
      include: { ticketTypes: { select: { kind: true, quantitySold: true, quantityReserved: true, quantityRefunded: true } } },
      orderBy: { startsAt: "desc" },
    }),
  ]);
  return (
    <>
      <PageTitle title="Vendas e repasses" subtitle="Valores calculados a partir do razão financeiro interno." />
      {fin.includesSimulated && <Alert variant="warning" className="mb-4">Inclui pagamentos simulados de desenvolvimento — não há dinheiro real envolvido.</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Vendas brutas" value={formatBRL(fin.grossCents)} />
        <StatCard label="Reembolsos e chargebacks" value={formatBRL(fin.refundCents + fin.chargebackCents)} />
        <StatCard label="Taxas da plataforma" value={formatBRL(fin.platformFeeCents)} />
        <StatCard label="Custos de processamento" value={formatBRL(fin.processingFeeCents)} />
        <StatCard label="A receber (estimado)" value={formatBRL(fin.organizerNetCents)} />
        <StatCard label="Conta de recebimento" value={PAYMENT_ACCOUNT_STATUS[fin.paymentAccountStatus]} />
      </div>

      <section className="mt-8">
        <h2 className="mb-3 font-display text-lg font-bold">Liquidações</h2>
        {env().SETTLEMENT_ENABLED && fin.settlements.length ? (
          <ul className="space-y-2">
            {fin.settlements.map((s) => (
              <li key={s.id} className="flex justify-between rounded-xl border border-border p-3 text-sm">
                <span>
                  {formatDateShort(s.periodStart)} – {formatDateShort(s.periodEnd)}
                </span>
                <span className="tabular-nums">{formatBRL(s.netCents)}</span>
                <Badge>{s.status}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Alert>
            Liquidação automática desabilitada: os repasses serão realizados pelo provedor de pagamento (split) após a integração real ser configurada e verificada. Nenhum valor é custodiado pela plataforma.
          </Alert>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 font-display text-lg font-bold">Meia-entrada por evento</h2>
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Evento</th>
                <th className="p-3 text-right">Cota</th>
                <th className="p-3 text-right">Meias vendidas/reservadas</th>
                <th className="p-3 text-right">Total vendido</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const half = e.ticketTypes.filter((t) => t.kind === "HALF_PRICE").reduce((s, t) => s + t.quantitySold + t.quantityReserved, 0);
                const sold = e.ticketTypes.reduce((s, t) => s + t.quantitySold, 0);
                const quota = e.halfPriceQuotaBps === null ? null : Math.floor((e.capacity * e.halfPriceQuotaBps) / 10_000);
                return (
                  <tr key={e.id} className="border-t border-border">
                    <td className="p-3">{e.title}</td>
                    <td className="p-3 text-right tabular-nums">{quota ?? "—"}</td>
                    <td className="p-3 text-right tabular-nums">{half}</td>
                    <td className="p-3 text-right tabular-nums">{sold}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 font-display text-lg font-bold">Transações recentes</h2>
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Pedido</th>
                <th className="p-3">Evento</th>
                <th className="p-3">Data</th>
                <th className="p-3">Pagamento</th>
                <th className="p-3 text-right">Total</th>
                <th className="p-3 text-right">Comissão</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="p-3 font-mono">{o.publicCode}</td>
                  <td className="p-3">{o.event.title}</td>
                  <td className="p-3">{formatDateTimeShort(o.paidAt ?? o.createdAt)}</td>
                  <td className="p-3">{o.payments.map((p) => p.method).join(", ") || "—"}{o.isSimulated && " (simulado)"}</td>
                  <td className="p-3 text-right tabular-nums">{formatBRL(o.totalCents)}</td>
                  <td className="p-3 text-right tabular-nums">{formatBRL(o.commissionCents)}</td>
                  <td className="p-3">{ORDER_STATUS[o.status].label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
