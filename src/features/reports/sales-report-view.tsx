import Link from "next/link";
import { StatCard } from "@/components/site/panel-shell";
import { formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";
import { TICKET_KIND } from "@/lib/labels";
import { formatBRL } from "@/lib/money";
import type { salesReport } from "@/server/services/reports";

type Report = Awaited<ReturnType<typeof salesReport>>;

/** Totais, vendas por tipo de ingresso e (sem filtro de evento) por evento. */
export function SalesReportView({ report, showEvents }: { report: Report; showEvents: boolean }) {
  const t = report.totals;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Pedidos pagos" value={String(t.orders)} hint={t.refundedOrders ? `${t.refundedOrders} reembolsado(s) depois` : undefined} />
        <StatCard label="Ingressos vendidos" value={String(t.tickets)} />
        <StatCard label="Total pago pelos compradores" value={formatBRL(t.grossCents)} hint={`Ingressos ${formatBRL(t.ticketNetCents)} + taxa de serviço ${formatBRL(t.serviceFeeCents)}`} />
        <StatCard label="Reembolsado" value={formatBRL(t.refundedCents)} />
        <StatCard label="Ticket médio (por pedido)" value={formatBRL(t.averageOrderCents)} />
        <StatCard label="Preço médio por ingresso" value={formatBRL(t.averageTicketCents)} hint="Líquido de desconto, sem taxa" />
        <StatCard label="Descontos de cupom" value={formatBRL(t.discountCents)} />
      </div>

      <section>
        <h3 className="mb-2 font-display text-base font-bold">Vendas por tipo de ingresso</h3>
        {report.byTicketType.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma venda no período.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[640px] text-sm" data-testid="sales-by-ticket-type">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Tipo</th>
                  {showEvents && <th className="p-3">Evento</th>}
                  <th className="p-3 text-right">Preço de tabela</th>
                  <th className="p-3 text-right">Vendidos</th>
                  <th className="p-3 text-right">Reembolsados</th>
                  <th className="p-3 text-right">Descontos</th>
                  <th className="p-3 text-right">Receita (líquida)</th>
                </tr>
              </thead>
              <tbody>
                {report.byTicketType.map((r) => (
                  <tr key={r.ticketTypeId} className="border-t border-border">
                    <td className="p-3">
                      {r.name}
                      <span className="block text-xs text-muted-foreground">{TICKET_KIND[r.kind] ?? r.kind}</span>
                    </td>
                    {showEvents && <td className="p-3">{r.eventTitle}</td>}
                    <td className="p-3 text-right tabular-nums">{formatBRL(r.listPriceCents)}</td>
                    <td className="p-3 text-right tabular-nums">{r.tickets}</td>
                    <td className="p-3 text-right tabular-nums">{r.refundedTickets}</td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(r.discountCents)}</td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(r.netCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showEvents && report.byEvent.length > 0 && (
        <section>
          <h3 className="mb-2 font-display text-base font-bold">Vendas por evento</h3>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[560px] text-sm" data-testid="sales-by-event">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Evento</th>
                  <th className="p-3 text-right">Pedidos</th>
                  <th className="p-3 text-right">Ingressos</th>
                  <th className="p-3 text-right">Total pago</th>
                </tr>
              </thead>
              <tbody>
                {report.byEvent.map((e) => (
                  <tr key={e.eventId} className="border-t border-border">
                    <td className="p-3">
                      <Link href={`/organizador/eventos/${e.eventId}`} className="font-semibold hover:underline">
                        {e.title}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{formatEventDateTime(e.startsAt, e.timezone)}</span>
                    </td>
                    <td className="p-3 text-right tabular-nums">{e.orders}</td>
                    <td className="p-3 text-right tabular-nums">{e.tickets}</td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(e.grossCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        Relatório gerado em {formatDateTimeShort(report.generatedAt)} (horário de Brasília). Vendas contadas pela data do pagamento, inclusive as reembolsadas depois.
      </p>
    </div>
  );
}
