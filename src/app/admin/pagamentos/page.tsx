import type { Metadata } from "next";
import { Suspense } from "react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { AdminActionButton } from "@/features/admin/controls";
import { adminRefundAction, retryRefundAction } from "@/features/admin/actions";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { formatDateTimeShort } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { ORDER_STATUS, PAYMENT_STATUS, REFUND_REASON, REFUND_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Pagamentos — admin", robots: { index: false } };

export default function AdminPayments() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  await requireAdmin();
  const [orders, refunds, flagged, webhooks] = await Promise.all([
    db.order.findMany({
      include: { event: { select: { title: true } }, organization: { select: { name: true } }, payments: { orderBy: { createdAt: "desc" } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.refund.findMany({ include: { order: { select: { publicCode: true } } }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.payment.findMany({ where: { failureReason: { in: ["AMOUNT_MISMATCH", "DUPLICATE_PAYMENT_REQUIRES_REFUND"] } }, include: { order: { select: { publicCode: true } } } }),
    db.paymentWebhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 20 }),
  ]);
  return (
    <>
      <PageTitle title="Pedidos e pagamentos" />
      {flagged.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-bold text-destructive">Pagamentos que exigem análise manual</h2>
          <ul className="divide-y divide-border rounded-2xl border border-destructive/40 bg-card text-sm">
            {flagged.map((p) => (
              <li key={p.id} className="p-3">
                Pedido {p.order.publicCode} · {p.provider} {p.providerPaymentId} · {formatBRL(p.amountCents)} · <strong>{p.failureReason}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-bold">Reembolsos</h2>
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Pedido</th>
                <th className="p-3">Motivo</th>
                <th className="p-3 text-right">Valor</th>
                <th className="p-3">Status</th>
                <th className="p-3">Data</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {refunds.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="p-3 font-mono">{r.order.publicCode}</td>
                  <td className="p-3">{REFUND_REASON[r.reason]}</td>
                  <td className="p-3 text-right tabular-nums">{formatBRL(r.amountCents)}</td>
                  <td className="p-3">
                    {REFUND_STATUS[r.status]} {r.note && <span className="block text-xs text-muted-foreground">{r.note}</span>}
                  </td>
                  <td className="p-3">{formatDateTimeShort(r.createdAt)}</td>
                  <td className="p-3">{(r.status === "FAILED" || r.status === "REQUESTED") && <AdminActionButton label="Reprocessar" action={retryRefundAction.bind(null, r.id)} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-bold">Pedidos recentes</h2>
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Pedido</th>
                <th className="p-3">Evento / organizador</th>
                <th className="p-3">Comprador</th>
                <th className="p-3 text-right">Total</th>
                <th className="p-3">Pedido</th>
                <th className="p-3">Pagamento</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="p-3">
                    <span className="font-mono">{o.publicCode}</span>
                    <span className="block text-xs text-muted-foreground">{formatDateTimeShort(o.createdAt)}</span>
                  </td>
                  <td className="p-3">
                    {o.event.title}
                    <span className="block text-xs text-muted-foreground">{o.organization.name}</span>
                  </td>
                  <td className="p-3">{o.buyerEmail}</td>
                  <td className="p-3 text-right tabular-nums">{formatBRL(o.totalCents)}</td>
                  <td className="p-3">
                    {ORDER_STATUS[o.status].label} {o.isSimulated && <Badge variant="warning">simulado</Badge>}
                  </td>
                  <td className="p-3 text-xs">{o.payments.map((p) => `${p.method} ${PAYMENT_STATUS[p.status]}`).join(" · ") || "—"}</td>
                  <td className="p-3">{o.status === "PAID" && <AdminActionButton label="Reembolsar" variant="outline" askReason="Motivo do reembolso" reasonRequired action={adminRefundAction.bind(null, o.id)} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold">Webhooks recebidos</h2>
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-xs">
          {webhooks.map((w) => (
            <li key={w.id} className="flex flex-wrap gap-x-3 p-3">
              <span className="font-mono">{w.provider}</span>
              <span>{w.eventType}</span>
              <span className="text-muted-foreground">{formatDateTimeShort(w.receivedAt)}</span>
              <span>{w.processedAt ? `processado: ${w.processingResult}` : <span className="text-destructive">pendente {w.error ? `(${w.error.slice(0, 80)})` : ""}</span>}</span>
              {w.attempts > 1 && <span>{w.attempts} entregas</span>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
