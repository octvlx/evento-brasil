import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { Alert, Badge, Input, Label, Select, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle, StatCard } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { couponUsage, organizerFinancials, organizerHalfPriceSummary, organizerPayouts, salesBySource, salesReport, type PayoutState } from "@/server/services/reports";
import { parseSalesPeriod, periodPresets } from "@/features/reports/period";
import { SalesReportView } from "@/features/reports/sales-report-view";
import { formatDateShort, formatDateTimeShort } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { ORDER_STATUS, PAYMENT_ACCOUNT_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Vendas e repasses", robots: { index: false } };

export default function SalesPage({ searchParams }: PageProps<"/organizador/vendas">) {
  return (
    <Suspense fallback={<Skeleton className="h-[600px]" />}>
      <Content searchParams={searchParams as Promise<Params>} />
    </Suspense>
  );
}

type Params = { de?: string; ate?: string; evento?: string; repasses?: string };

const PAYOUT_STATE: Record<PayoutState, { label: string; tone: "success" | "warning" | "danger" | "default" }> = {
  RELEASED: { label: "Liberado", tone: "success" },
  PENDING: { label: "A liberar", tone: "warning" },
  REFUNDED: { label: "Estornado", tone: "danger" },
  UNKNOWN: { label: "Sem informação", tone: "default" },
};
const PATH = "/organizador/vendas";

/** Link com os filtros (sem parâmetros vazios). */
function hrefWith(path: string, params: Record<string, string | undefined>) {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
  return q.size ? `${path}?${q}` : path;
}

async function Content({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { user, org, can } = await requireOrganizer("/organizador/vendas");
  if (!can("finance:read")) redirect("/organizador");
  const period = parseSalesPeriod({ de: sp.de, ate: sp.ate });
  const events = await db.event.findMany({ where: { organizationId: org.id }, select: { id: true, title: true }, orderBy: { startsAt: "desc" } });
  const eventId = events.some((e) => e.id === sp.evento) ? sp.evento! : "";
  const report = await salesReport(db, user, org.id, { period, eventId: eventId || null });
  const filters = { de: period.de || undefined, ate: period.ate || undefined, evento: eventId || undefined };
  const fin = await organizerFinancials(db, user, org.id);
  const payouts = await organizerPayouts(db, user, org.id, Number(sp.repasses) || 1);
  const [orders, halfEvents, sources, coupons] = await Promise.all([
    db.order.findMany({
      where: { organizationId: org.id, status: { notIn: ["PENDING_PAYMENT", "EXPIRED", "CANCELLED"] } },
      include: { event: { select: { title: true } }, payments: { select: { method: true, status: true, processingFeeCents: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    organizerHalfPriceSummary(db, user, org.id),
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

      <section className="mt-8" aria-labelledby="relatorio-periodo">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 id="relatorio-periodo" className="font-display text-lg font-bold">
            Relatório de vendas
          </h2>
          <a href={hrefWith("/api/organizador/vendas", filters)} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Download aria-hidden /> Exportar CSV
          </a>
        </div>
        <form className="mb-3 flex flex-wrap items-end gap-3" aria-label="Filtrar relatório de vendas">
          <div>
            <Label htmlFor="vendas-de">De</Label>
            <Input id="vendas-de" name="de" type="date" defaultValue={period.de} className="mt-1.5 w-auto" />
          </div>
          <div>
            <Label htmlFor="vendas-ate">Até</Label>
            <Input id="vendas-ate" name="ate" type="date" defaultValue={period.ate} className="mt-1.5 w-auto" />
          </div>
          <div className="min-w-0 basis-full sm:basis-auto">
            <Label htmlFor="vendas-evento">Evento</Label>
            <Select id="vendas-evento" name="evento" defaultValue={eventId} className="mt-1.5 w-full sm:w-auto sm:max-w-xs">
              <option value="">Todos os eventos</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </Select>
          </div>
          <button className={buttonVariants({ variant: "secondary" })}>Aplicar</button>
        </form>
        <nav className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Períodos rápidos">
          {periodPresets().map((p) => {
            const active = p.de === period.de && p.ate === period.ate;
            return (
              <Link
                key={p.label}
                href={hrefWith(PATH, { de: p.de || undefined, ate: p.ate || undefined, evento: eventId || undefined })}
                aria-current={active ? "true" : undefined}
                className={buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" })}
              >
                {p.label}
              </Link>
            );
          })}
        </nav>
        <SalesReportView report={report} showEvents={!eventId} />
      </section>

      <section className="mt-8" id="repasses" aria-labelledby="payouts-title">
        <h2 id="payouts-title" className="mb-1 font-display text-lg font-bold">
          Repasses do Mercado Pago
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">
          O dinheiro de cada venda vai direto para a sua conta do Mercado Pago (split); a plataforma não guarda nem transfere valores. Aqui você acompanha quando cada valor fica disponível lá,
          como o Mercado Pago informa.
        </p>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <StatCard label="Já liberado na sua conta" value={formatBRL(payouts.releasedCents)} />
          <StatCard
            label="A liberar"
            value={formatBRL(payouts.pendingCents)}
            hint={payouts.nextReleaseAt ? `Próxima liberação: ${formatDateShort(payouts.nextReleaseAt)}` : undefined}
          />
        </div>
        {payouts.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum pagamento recebido ainda.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[720px] text-sm" data-testid="payouts">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Venda</th>
                  <th className="p-3">Pedido</th>
                  <th className="p-3 text-right">Pago</th>
                  <th className="p-3 text-right">Líquido para você</th>
                  <th className="p-3">Liberação</th>
                  <th className="p-3">Situação</th>
                </tr>
              </thead>
              <tbody>
                {payouts.items.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="p-3">{formatDateTimeShort(p.paidAt)}</td>
                    <td className="p-3">
                      <span className="font-mono text-xs">{p.orderCode}</span> · {p.eventTitle}
                      {p.isSimulated && <span className="ml-1 text-xs text-muted-foreground">(teste)</span>}
                    </td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(p.amountCents)}</td>
                    <td className="p-3 text-right tabular-nums" title={p.netFromProvider ? "Informado pelo Mercado Pago" : "Estimado pelo pedido (o Mercado Pago ainda não informou)"}>
                      {formatBRL(p.netCents)}
                      {!p.netFromProvider && p.state !== "REFUNDED" && <span className="text-xs text-muted-foreground"> (estimado)</span>}
                    </td>
                    <td className="p-3">{p.releaseAt ? formatDateShort(p.releaseAt) : "—"}</td>
                    <td className="p-3">
                      <Badge variant={PAYOUT_STATE[p.state].tone}>{PAYOUT_STATE[p.state].label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {payouts.pageCount > 1 && (
          <nav aria-label="Paginação dos repasses" className="mt-3 flex items-center gap-2 text-sm">
            {payouts.page > 1 && (
              <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`${hrefWith(PATH, { ...filters, repasses: String(payouts.page - 1) })}#repasses`}>
                Anterior
              </Link>
            )}
            <span className="text-muted-foreground">
              Página {payouts.page} de {payouts.pageCount}
            </span>
            {payouts.page < payouts.pageCount && (
              <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={`${hrefWith(PATH, { ...filters, repasses: String(payouts.page + 1) })}#repasses`}>
                Próxima
              </Link>
            )}
          </nav>
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
        <h2 className="mb-1 font-display text-lg font-bold">Meia-entrada por evento</h2>
        <p className="mb-3 text-sm text-muted-foreground">O CSV traz cota legal, saldo, prazo da reserva, vendas, reembolsos, cancelamentos, check-ins e vendas por dia — sem dados pessoais. Cada exportação fica registrada.</p>
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Evento</th>
                <th className="p-3 text-right">Cota legal</th>
                <th className="p-3 text-right">Meias vendidas/reservadas</th>
                <th className="p-3 text-right">Saldo da cota</th>
                <th className="p-3 text-right">Total vendido</th>
                <th className="p-3 text-right">Relatório</th>
              </tr>
            </thead>
            <tbody>
              {halfEvents.map((e) => {
                return (
                  <tr key={e.id} className="border-t border-border">
                    <td className="p-3">{e.title}</td>
                    <td className="p-3 text-right tabular-nums">{e.quota ?? "—"}</td>
                    <td className="p-3 text-right tabular-nums">{e.halfCommitted}</td>
                    <td className="p-3 text-right tabular-nums">{e.balance ?? "—"}</td>
                    <td className="p-3 text-right tabular-nums">{e.totalSold}</td>
                    <td className="p-3 text-right">
                      <a href={`/api/organizador/eventos/${e.id}/meia-entrada`} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label={`Baixar CSV de meia-entrada de ${e.title}`}>
                        CSV
                      </a>
                    </td>
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
