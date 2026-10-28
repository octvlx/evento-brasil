import type { Metadata } from "next";
import { Suspense } from "react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { AdminActionButton } from "@/features/admin/controls";
import { adminRefundAction, retryRefundAction } from "@/features/admin/actions";
import { ReasonedDecisionButton } from "@/features/admin/decision-controls";
import { ADMIN_REFUND_REASON } from "@/features/admin/labels";
import { adminRestoreFailedRefundAction, adminRetryFailedRefundAction } from "@/features/orders/actions";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { listFailedRefunds, REFUND_RETRY_POLICY } from "@/server/services/refunds";
import { formatDateTimeShort } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { ORDER_STATUS, PAYMENT_STATUS, REFUND_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Pagamentos — admin", robots: { index: false } };

export default function AdminPayments() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const admin = await requireAdmin();
  const [failed, orders, refunds, flagged, webhooks] = await Promise.all([
    listFailedRefunds(db, admin),
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
      <section id="reembolsos-falhos" className="mb-8">
        <h2 className="mb-1 text-sm font-bold">Reembolsos com falha ({failed.length})</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          A manutenção tenta de novo sozinha até {REFUND_RETRY_POLICY.maxAutomaticAttempts} vezes. Depois disso (ou em bloqueio), decida: reprocessar no provedor ou desistir do
          reembolso e devolver os ingressos ao comprador.
        </p>
        {failed.length === 0 ? (
          <p className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">Nenhum reembolso com falha.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Pedido / evento</th>
                  <th className="p-3">Motivo</th>
                  <th className="p-3 text-right">Valor</th>
                  <th className="p-3">Tentativas</th>
                  <th className="p-3">Último erro</th>
                  <th className="p-3">Decisão</th>
                </tr>
              </thead>
              <tbody>
                {failed.map((f) => (
                  <tr key={f.refundId} className={`border-t border-border align-top ${f.awaitingAdminDecision ? "bg-destructive/5" : ""}`}>
                    <td className="p-3">
                      <span className="font-mono">{f.orderPublicCode}</span>
                      <span className="block text-xs text-muted-foreground">{f.eventTitle}</span>
                    </td>
                    <td className="p-3">{ADMIN_REFUND_REASON[f.reason] ?? f.reason}</td>
                    <td className="p-3 text-right tabular-nums">{formatBRL(f.amountCents)}</td>
                    <td className="p-3">
                      {f.attempts}/{REFUND_RETRY_POLICY.maxAutomaticAttempts}
                      <span className="block text-xs text-muted-foreground">
                        {f.awaitingAdminDecision ? "aguardando decisão" : f.nextRetryAt ? `próxima: ${formatDateTimeShort(f.nextRetryAt)}` : ""}
                      </span>
                    </td>
                    <td className="max-w-xs p-3 text-xs text-muted-foreground">
                      {f.note}
                      <span className="block">{formatDateTimeShort(f.failedAt)}</span>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-col items-start gap-2">
                        <ReasonedDecisionButton
                          label="Reprocessar"
                          confirmTitle={`Reprocessar o reembolso do pedido ${f.orderPublicCode}?`}
                          confirmText={`Nova tentativa de ${formatBRL(f.amountCents)} no provedor, com a mesma chave de idempotência (não duplica o estorno).`}
                          doneText="Reprocessamento enviado."
                          action={adminRetryFailedRefundAction.bind(null, f.refundId)}
                        />
                        {f.restoreBlockedReason ? (
                          <span className="max-w-[16rem] text-xs text-muted-foreground">{f.restoreBlockedReason}</span>
                        ) : (
                          <ReasonedDecisionButton
                            label="Restaurar ingressos"
                            variant="destructive"
                            confirmTitle={`Desistir do reembolso do pedido ${f.orderPublicCode}?`}
                            confirmText="O provedor é consultado antes: se o estorno já ocorreu, ele é confirmado. Senão o reembolso fica recusado, o pedido volta a pago e os ingressos voltam a valer."
                            doneText="Decisão registrada."
                            action={adminRestoreFailedRefundAction.bind(null, f.refundId)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
                  <td className="p-3">{ADMIN_REFUND_REASON[r.reason] ?? r.reason}</td>
                  <td className="p-3 text-right tabular-nums">{formatBRL(r.amountCents)}</td>
                  <td className="p-3">
                    {REFUND_STATUS[r.status]} {r.note && <span className="block text-xs text-muted-foreground">{r.note}</span>}
                  </td>
                  <td className="p-3">{formatDateTimeShort(r.createdAt)}</td>
                  <td className="p-3">
                    {r.status === "REQUESTED" && <AdminActionButton label="Reprocessar" action={retryRefundAction.bind(null, r.id)} />}
                    {r.status === "FAILED" && (
                      <a href="#reembolsos-falhos" className="text-xs text-secondary underline-offset-4 hover:underline">
                        ver falhas
                      </a>
                    )}
                  </td>
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
