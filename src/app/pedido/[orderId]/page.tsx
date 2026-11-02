import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CalendarClock, CheckCircle2, Clock, Download, FileText, RotateCcw, Ticket, XCircle } from "lucide-react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { OrderSummary } from "@/components/site/order-summary";
import { ClearPurchasedCart } from "@/features/orders/persistent-cart";
import { PendingPoller, RefundButton } from "@/features/orders/order-actions";
import { CancellationRequestForm } from "@/features/orders/cancellation-form";
import { CancellationRequestList } from "@/features/orders/cancellation-list";
import { refundView, revocationText } from "@/features/orders/status-view";
import { cancelOrderAction } from "@/features/orders/actions";
import { describeChangeValue, isRelevantField, RELEVANT_FIELD_LABELS, type ChangeSnapshotJson } from "@/features/organizer/event-change-rules";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { getOrderForBuyer } from "@/server/services/orders";
import { openChangeRefundWindow, refundEligibility } from "@/server/services/refunds";
import { PROVISIONAL_CANCELLATION_RESPONSE_DAYS } from "@/server/services/cancellation-requests";
import { formatDateShort, formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { CANCEL_HELP_HREF } from "@/lib/help-links";
import { ORDER_STATUS, REFUND_REASON, REFUND_STATUS, TICKET_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Pedido", robots: { index: false } };

export default function OrderPage({ params }: PageProps<"/pedido/[orderId]">) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <Suspense fallback={<Skeleton className="h-96" />}>
        <OrderContent params={params} />
      </Suspense>
    </div>
  );
}

async function OrderContent({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const user = await requireUser(`/pedido/${orderId}`);
  const order = await getOrderForBuyer(db, user, orderId);
  const completedDraft = order.status === "PAID" && order.checkoutReviewRequired ? await db.checkoutDraft.findUnique({ where: { orderId: order.id }, select: { idempotencyKey: true } }) : null;
  const st = ORDER_STATUS[order.status];
  const now = new Date();
  const [changeWindow, cancellations] = await Promise.all([
    openChangeRefundWindow(db, order.eventId, order.paidAt, now),
    db.cancellationRequest.findMany({ where: { orderId: order.id, requestedById: user.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const eligibility = refundEligibility(order, order.event, order.tickets, now, changeWindow);
  // O que mudou: a alteração original que abriu a janela (o prazo pode vir de uma prorrogação).
  const change = eligibility.eligible && eligibility.basis === "EVENT_CHANGED"
    ? await db.eventChange.findUnique({ where: { id: eligibility.window.eventChangeId }, select: { changedFields: true, before: true, after: true, reason: true, createdAt: true } })
    : null;
  const tz = order.event.timezone;
  const canRequestCancellation = !cancellations.some((c) => c.status === "OPEN") && (order.status === "PAID" || order.status === "PENDING_PAYMENT");
  const refund = refundView(order.status, order.refunds);
  const isRefund = order.status === "REFUND_PENDING" || order.status === "REFUNDED";
  // Última tentativa recusada pelo provedor, com o pedido ainda reservado: permite tentar de novo.
  const lastPayment = order.payments[0];
  // Só recusas do provedor (com pagamento vinculado); falhas antes da cobrança aparecem no checkout.
  const rejected = order.status === "PENDING_PAYMENT" && !!lastPayment?.providerPaymentId && (lastPayment.status === "FAILED" || lastPayment.status === "CANCELLED");
  const Icon = order.status === "PAID" ? CheckCircle2 : order.status === "PENDING_PAYMENT" ? Clock : isRefund ? RotateCcw : XCircle;

  return (
    <>
      {completedDraft && <ClearPurchasedCart eventId={order.eventId} idempotencyKey={completedDraft.idempotencyKey} />}
      <div className="flex items-start gap-4">
        <Icon className={`size-10 shrink-0 ${order.status === "PAID" ? "text-success" : order.status === "PENDING_PAYMENT" || order.status === "REFUND_PENDING" ? "text-warning" : "text-muted-foreground"}`} aria-hidden />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pedido {order.publicCode}</p>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">
            {order.status === "PAID"
              ? "Pagamento confirmado!"
              : rejected
                ? "Pagamento não aprovado"
                : order.status === "PENDING_PAYMENT"
                  ? "Aguardando confirmação do pagamento."
                  : st.label}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {order.event.title} · {formatEventDateTime(order.event.startsAt, order.event.timezone)}
          </p>
        </div>
      </div>

      {order.isSimulated && (
        <Alert variant="warning" className="mt-6">
          Pedido de <strong>ambiente de testes</strong> com pagamento simulado — não representa uma compra real.
        </Alert>
      )}

      {refund && isRefund && (
        <Alert variant={refund.tone} className="mt-6">
          <strong>{refund.title}.</strong> {refund.detail}
        </Alert>
      )}

      {eligibility.eligible && eligibility.basis === "EVENT_CHANGED" && (
        <Card className="mt-6 space-y-3 border-warning/40 p-5" data-testid="event-change-window">
          <h2 className="flex items-center gap-2 font-display text-lg font-bold">
            <CalendarClock className="size-5 text-warning" aria-hidden /> O evento foi alterado depois da sua compra
          </h2>
          {change && (
            <>
              <ul className="space-y-1 text-sm">
                {change.changedFields.filter(isRelevantField).map((f) => (
                  <li key={f}>
                    <span className="text-muted-foreground">{RELEVANT_FIELD_LABELS[f]}:</span> {describeChangeValue(f, change.before as ChangeSnapshotJson, tz)} →{" "}
                    <strong>{describeChangeValue(f, change.after as ChangeSnapshotJson, tz)}</strong>
                  </li>
                ))}
              </ul>
              <p className="text-sm">
                <span className="text-muted-foreground">Motivo informado pelo organizador:</span> {change.reason}
              </p>
            </>
          )}
          <p className="font-semibold">
            Reembolso integral, com as taxas, até <span data-testid="change-refund-until">{formatDateShort(eligibility.window.refundUntil, tz)}</span> ({formatDateTimeShort(eligibility.window.refundUntil, tz)}).
          </p>
          <p className="text-sm text-muted-foreground">Se preferir manter os ingressos, não precisa fazer nada: eles continuam válidos para a nova data/local.</p>
          <RefundButton orderId={order.id} />
        </Card>
      )}

      {order.status === "PAID" && (
        <Alert variant="success" className="mt-6" data-testid="payment-confirmed">
          Pagamento confirmado pelo provedor. {order.tickets.length} {order.tickets.length === 1 ? "ingresso emitido" : "ingressos emitidos"} — veja abaixo.
        </Alert>
      )}

      {order.status === "PENDING_PAYMENT" && (
        <Card className="mt-6 space-y-3 p-5">
          {rejected ? (
            <p className="text-sm" data-testid="payment-rejected">
              O pagamento não foi aprovado e nenhum ingresso foi emitido. Você pode tentar de novo, com outro cartão ou forma de pagamento, até{" "}
              <strong>{formatDateTimeShort(order.expiresAt)}</strong>.
            </p>
          ) : (
            <p className="text-sm">
              Seus ingressos serão emitidos automaticamente quando o provedor confirmar o pagamento. Esta página se atualiza sozinha. A reserva vale até{" "}
              <strong>{formatDateTimeShort(order.expiresAt)}</strong>.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Link href={`/checkout/${order.id}`} className={buttonVariants({ variant: "secondary" })}>
              {rejected ? "Tentar pagar de novo" : "Voltar ao pagamento"}
            </Link>
            <form action={cancelOrderAction.bind(null, order.id)}>
              <button className={buttonVariants({ variant: "ghost" })}>Cancelar pedido</button>
            </form>
          </div>
          <PendingPoller orderId={order.id} />
        </Card>
      )}

      {order.tickets.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-xl font-bold">Ingressos</h2>
            {order.tickets.some((t) => t.status !== "REVOKED") && (
              <a href={`/api/orders/${order.id}/pdf`} target="_blank" rel="noopener" className={buttonVariants({ variant: "outline", size: "sm" })}>
                <Download aria-hidden /> Salvar todos (PDF)
              </a>
            )}
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {order.tickets.map((t) => {
              const ts = TICKET_STATUS[t.status];
              return (
                <li key={t.id}>
                  <Link href={`/ingressos/${t.code}`} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 hover:border-secondary">
                    <Ticket className="size-6 text-secondary" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{t.ticketType.name}</p>
                      <p className="truncate text-sm text-muted-foreground">{t.holderName}</p>
                      {t.status === "REVOKED" && <p className="text-xs text-muted-foreground">{revocationText(t.revocationReason)}</p>}
                    </div>
                    <Badge variant={ts.tone === "success" ? "success" : ts.tone === "danger" ? "danger" : "default"}>{ts.label}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-3 font-display text-lg font-bold">Resumo</h2>
          <OrderSummary items={order.items} subtotalCents={order.subtotalCents} serviceFeeCents={order.serviceFeeCents} totalCents={order.totalCents} discountCents={order.discountCents} couponCode={order.couponCode} />
        </Card>
        <Card className="space-y-3 p-5">
          <h2 className="font-display text-lg font-bold">Reembolso</h2>
          {refund && !isRefund && (
            <div>
              <p className="font-semibold">{refund.title}</p>
              <p className="text-sm text-muted-foreground">{refund.detail}</p>
            </div>
          )}
          {order.refunds.length > 0 && (
            <ul className="space-y-1 text-sm">
              {order.refunds.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-x-3">
                  <span>
                    {REFUND_REASON[r.reason]} · {formatDateTimeShort(r.createdAt)}
                  </span>
                  <span>
                    <span className="tabular-nums">{formatBRL(r.amountCents)}</span> · <strong>{REFUND_STATUS[r.status]}</strong>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {eligibility.eligible ? (
            eligibility.basis === "EVENT_CHANGED" ? (
              <p className="text-sm">{eligibility.message}</p>
            ) : (
              <RefundButton orderId={order.id} />
            )
          ) : (
            !order.refunds.length && <p className="text-sm text-muted-foreground">{eligibility.reason}</p>
          )}
          <p className="text-xs text-muted-foreground">Política do evento: {order.event.refundPolicy}</p>
          <Link href={CANCEL_HELP_HREF} className="inline-block text-sm font-semibold text-secondary hover:underline">
            Cancelar compra / arrependimento: como funciona
          </Link>
        </Card>
      </div>

      {(canRequestCancellation || cancellations.length > 0) && (
        <section id="cancelamento" className="mt-8 space-y-3" aria-labelledby="cancellation-title">
          <h2 id="cancellation-title" className="flex items-center gap-2 font-display text-xl font-bold">
            <FileText className="size-5 text-secondary" aria-hidden /> Pedido de cancelamento
          </h2>
          <p className="text-sm text-muted-foreground">
            Fora dos prazos de reembolso automático, ou se algo deu errado com a compra, peça o cancelamento: você recebe um protocolo e a resposta da equipe fica registrada aqui.
          </p>
          <CancellationRequestList items={cancellations} />
          {canRequestCancellation && <CancellationRequestForm orderId={order.id} responseDays={PROVISIONAL_CANCELLATION_RESPONSE_DAYS} />}
        </section>
      )}
    </>
  );
}
