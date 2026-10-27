import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle, StatCard } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { couponUsage, organizerFinancials, salesBySource } from "@/server/services/reports";
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
  const [orders, events, sources, coupons] = await Promise.all([
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
    salesBySource(db, user, org.id),
    couponUsage(db, user, org.id),
  ]);
  return (
    <>
      <PageTitle title="Vendas e repasses" subtitle="Valores calculados a partir do razão financeiro interno." />
      {fin.includesSimulated && <Alert variant="warning" className="mb-4">Inclui pagamentos simulados de desenvolvimento — não há dinheiro real envolvido.</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Vendas brutas (já com descontos de cupom)" value={formatBRL(fin.grossCents)} />
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
        <h2 className="mb-1 font-display text-lg font-bold">Vendas por origem</h2>
        <p className="mb-3 text-sm text-muted-foreground">Pedidos pagos por link de divulgação ou utm_source. Valor de ingressos líquido de desconto, sem taxa de serviço.</p>
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma venda paga ainda.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[560px] text-sm" data-testid="sales-by-source">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Origem</th>
                  <th className="p-3 text-right">Pedidos</th>
                  <th className="p-3 text-right">Ingressos (líquido)</th>
                  <th className="p-3 text-right">Descontos</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((r) => (
                  <tr key={r.key} className="border-t border-border">
                    <td className="p-3">
                      {r.label} {r.kind === "utm" && <Badge>utm</Badge>}
                      {r.detail && <span className="block text-xs text-muted-foreground">{r.detail}</span>}
                    </td>
                    <td className="p-3 text-right tabular-nums">{r.orders}</td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(r.netTicketCents)}</td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(r.discountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-1 font-display text-lg font-bold">Uso de cupons</h2>
        <p className="mb-3 text-sm text-muted-foreground">Resgates contam pedidos com ingresso emitido (inclui os reembolsados depois); a coluna de pedidos pagos não.</p>
        {coupons.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum cupom criado. Crie cupons na página de cada evento.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[720px] text-sm" data-testid="coupon-usage">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Cupom</th>
                  <th className="p-3">Evento</th>
                  <th className="p-3">Desconto</th>
                  <th className="p-3 text-right">Resgates</th>
                  <th className="p-3 text-right">Pedidos pagos</th>
                  <th className="p-3 text-right">Desconto concedido</th>
                  <th className="p-3 text-right">Ingressos (líquido)</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="p-3 font-mono">
                      {c.code} {c.disabled && <Badge variant="warning">Desativado</Badge>}
                    </td>
                    <td className="p-3">{c.eventTitle ?? "Toda a organização"}</td>
                    <td className="p-3">{c.discountType === "PERCENT" ? `${((c.percentBps ?? 0) / 100).toLocaleString("pt-BR")}%` : `${formatBRL(c.amountCents ?? 0)}/ingresso`}</td>
                    <td className="p-3 text-right tabular-nums">
                      {c.timesRedeemed}
                      {c.maxUses ? ` / ${c.maxUses}` : ""}
                    </td>
                    <td className="p-3 text-right tabular-nums">{c.paidOrders}</td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(c.discountCents)}</td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(c.netTicketCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
