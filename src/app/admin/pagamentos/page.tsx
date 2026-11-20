import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Badge, Input, Label, Select, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { AdminActionButton } from "@/features/admin/controls";
import { AdminPartialRefund } from "@/features/admin/partial-refund";
import { adminRefundAction, retryRefundAction } from "@/features/admin/actions";
import { ReasonedDecisionButton } from "@/features/admin/decision-controls";
import { ADMIN_REFUND_REASON } from "@/features/admin/labels";
import { adminHref, Pager } from "@/features/admin/pager";
import { adminRestoreFailedRefundAction, adminRetryFailedRefundAction } from "@/features/orders/actions";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { listFailedRefunds, REFUND_RETRY_POLICY } from "@/server/services/refunds";
import {
  adminFinancialChecks,
  listAdminOrders,
  listAdminRefunds,
  listPaymentsForReview,
  listWebhookEvents,
  parseOrderStatus,
  parsePage,
  PAYMENT_REVIEW_REASONS,
} from "@/server/services/admin-oversight";
import { formatDateTimeShort } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { ORDER_STATUS, PAYMENT_STATUS, REFUND_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Pagamentos — admin", robots: { index: false } };

type Search = { q?: string; status?: string; pagina?: string; reembolsos?: string; webhooks?: string; pendentes?: string };

export default function AdminPayments({ searchParams }: PageProps<"/admin/pagamentos">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<Search>} />
    </Suspense>
  );
}

const PATH = "/admin/pagamentos";
const MAX_IDS_SHOWN = 10;

async function Content({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin("finance:refunds");
  const sp = await searchParams;
  const status = parseOrderStatus(sp.status);
  const pendingOnly = sp.pendentes === "1";
  const [failed, violations, flagged, orders, refunds, webhooks] = await Promise.all([
    listFailedRefunds(db, admin),
    adminFinancialChecks(db, admin),
    listPaymentsForReview(db, admin),
    listAdminOrders(db, admin, { q: sp.q, status, page: parsePage(sp.pagina) }),
    listAdminRefunds(db, admin, { page: parsePage(sp.reembolsos) }),
    listWebhookEvents(db, admin, { page: parsePage(sp.webhooks), pendingOnly }),
  ]);
  // Estado das três listas paginadas: cada link mantém o das outras.
  const params: Record<string, string | undefined> = {
    q: orders.q || undefined,
    status,
    pagina: orders.page > 1 ? String(orders.page) : undefined,
    reembolsos: refunds.page > 1 ? String(refunds.page) : undefined,
    webhooks: webhooks.page > 1 ? String(webhooks.page) : undefined,
    pendentes: pendingOnly ? "1" : undefined,
  };
  return (
    <>
      <PageTitle title="Pedidos e pagamentos" />
      <section id="verificacoes" className="mb-8">
        <h2 className="mb-1 text-sm font-bold">Verificações financeiras ({violations.length})</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Os mesmos invariantes que a manutenção confere a cada minuto, lidos agora. Nada é corrigido sozinho: cada divergência é um incidente para análise.
        </p>
        {violations.length === 0 ? (
          <p className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">Nenhuma divergência encontrada.</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-destructive/40 bg-card text-sm">
            {violations.map((v) => (
              <li key={v.code} className="p-3">
                <span className="font-bold text-destructive">{v.description}</span> <span className="font-mono text-xs text-muted-foreground">{v.code}</span>
                <span className="block text-xs text-muted-foreground">
                  {v.ids.length} {v.ids.length === 1 ? "registro" : "registros"}: <span className="break-all font-mono">{v.ids.slice(0, MAX_IDS_SHOWN).join(", ")}</span>
                  {v.ids.length > MAX_IDS_SHOWN && ` e mais ${v.ids.length - MAX_IDS_SHOWN}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

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
                    <td className="p-3 text-right tabular-nums">
                      {formatBRL(f.amountCents)}
                      {f.partial && <span className="block text-xs text-muted-foreground">parcial</span>}
                    </td>
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
        <section id="pagamentos-em-analise" className="mb-8">
          <h2 className="mb-2 text-sm font-bold text-destructive">Pagamentos que exigem análise manual ({flagged.length})</h2>
          <ul className="divide-y divide-border rounded-2xl border border-destructive/40 bg-card text-sm">
            {flagged.map((p) => (
              <li key={p.id} className="p-3">
                Pedido <span className="font-mono">{p.order.publicCode}</span> · {p.provider}{" "}
                {p.providerPaymentId ?? <span className="break-all font-mono text-xs">ref. {p.idempotencyKey}</span>} · {p.method} · {formatBRL(p.amountCents)} ·{" "}
                {PAYMENT_STATUS[p.status]} · {formatDateTimeShort(p.createdAt)}
                <strong className="block text-xs">{PAYMENT_REVIEW_REASONS[p.failureReason as keyof typeof PAYMENT_REVIEW_REASONS] ?? p.failureReason}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section id="reembolsos" className="mb-8">
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
              {refunds.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-muted-foreground">
                    Nenhum reembolso.
                  </td>
                </tr>
              )}
              {refunds.items.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="p-3 font-mono">{r.order.publicCode}</td>
                  <td className="p-3">{ADMIN_REFUND_REASON[r.reason] ?? r.reason}</td>
                  <td className="p-3 text-right tabular-nums">
                    {formatBRL(r.amountCents)}
                    {r.partial && <span className="block text-xs text-muted-foreground">parcial</span>}
                  </td>
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
        <Pager path={PATH} params={params} page={refunds.page} pageCount={refunds.pageCount} total={refunds.total} param="reembolsos" anchor="reembolsos" />
      </section>

      <section id="pedidos" className="mb-8">
        <h2 className="mb-2 text-sm font-bold">Pedidos</h2>
        <form method="get" action={PATH} aria-label="Buscar pedidos" className="mb-3 flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-3 shadow-card">
          <div className="min-w-[14rem] flex-1 space-y-1">
            <Label htmlFor="orders-q">Código, e-mail do comprador ou evento</Label>
            <Input id="orders-q" name="q" defaultValue={orders.q} maxLength={200} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="orders-status">Situação</Label>
            <Select id="orders-status" name="status" defaultValue={status ?? ""}>
              <option value="">Todas</option>
              {Object.entries(ORDER_STATUS).map(([key, s]) => (
                <option key={key} value={key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          {pendingOnly && <input type="hidden" name="pendentes" value="1" />}
          <button type="submit" className={buttonVariants({ size: "sm" })}>
            Buscar
          </button>
          {(orders.q || status) && (
            <Link href={`${adminHref(PATH, { ...params, q: undefined, status: undefined, pagina: undefined })}#pedidos`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Limpar
            </Link>
          )}
        </form>
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
              {orders.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-muted-foreground">
                    Nenhum pedido encontrado.
                  </td>
                </tr>
              )}
              {orders.items.map((o) => (
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
                  <td className="p-3">
                    {o.status === "PAID" && (
                      <div className="flex flex-col items-start gap-1">
                        <AdminActionButton label="Reembolsar" variant="outline" askReason="Motivo do reembolso" reasonRequired action={adminRefundAction.bind(null, o.id)} />
                        {o.tickets.length > 1 && (
                          <AdminPartialRefund
                            orderId={o.id}
                            tickets={o.tickets.map((t) => ({ id: t.id, label: t.ticketType.name, holder: t.holderName, amountCents: t.orderItem.unitPriceCents + t.orderItem.serviceFeePerUnitCents }))}
                          />
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager path={PATH} params={params} page={orders.page} pageCount={orders.pageCount} total={orders.total} anchor="pedidos" />
      </section>

      <section id="webhooks">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-bold">Webhooks recebidos</h2>
          <Link
            href={`${adminHref(PATH, { ...params, webhooks: undefined, pendentes: pendingOnly ? undefined : "1" })}#webhooks`}
            aria-current={pendingOnly ? "true" : undefined}
            className={buttonVariants({ variant: pendingOnly ? "default" : "outline", size: "sm" })}
          >
            {pendingOnly ? "Mostrar todos" : "Só pendentes"}
          </Link>
        </div>
        {webhooks.items.length === 0 ? (
          <p className="rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">Nenhum webhook{pendingOnly ? " pendente" : ""}.</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-xs">
            {webhooks.items.map((w) => (
              <li key={w.id} className="flex flex-wrap gap-x-3 p-3">
                <span className="font-mono">{w.provider}</span>
                <span>{w.eventType}</span>
                <span className="text-muted-foreground">{formatDateTimeShort(w.receivedAt)}</span>
                <span>{w.processedAt ? `processado: ${w.processingResult}` : <span className="text-destructive">pendente {w.error ? `(${w.error.slice(0, 80)})` : ""}</span>}</span>
                {w.attempts > 1 && <span>{w.attempts} entregas</span>}
              </li>
            ))}
          </ul>
        )}
        <Pager path={PATH} params={params} page={webhooks.page} pageCount={webhooks.pageCount} total={webhooks.total} param="webhooks" anchor="webhooks" />
      </section>
    </>
  );
}
