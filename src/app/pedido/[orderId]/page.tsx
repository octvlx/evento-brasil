import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CheckCircle2, Clock, Download, RotateCcw, Ticket, XCircle } from "lucide-react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { OrderSummary } from "@/components/site/order-summary";
import { PendingPoller, RefundButton } from "@/features/orders/order-actions";
import { refundView, revocationText } from "@/features/orders/status-view";
import { cancelOrderAction } from "@/features/orders/actions";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { getOrderForBuyer } from "@/server/services/orders";
import { refundEligibility } from "@/server/services/refunds";
import { formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";
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
  const st = ORDER_STATUS[order.status];
  const eligibility = refundEligibility(order, order.event, order.tickets, new Date());
  const refund = refundView(order.status, order.refunds);
  const isRefund = order.status === "REFUND_PENDING" || order.status === "REFUNDED";
  const Icon = order.status === "PAID" ? CheckCircle2 : order.status === "PENDING_PAYMENT" ? Clock : isRefund ? RotateCcw : XCircle;

  return (
    <>
      {order.status === "PENDING_PAYMENT" && <PendingPoller orderId={order.id} />}
      <div className="flex items-start gap-4">
        <Icon className={`size-10 shrink-0 ${order.status === "PAID" ? "text-success" : order.status === "PENDING_PAYMENT" || order.status === "REFUND_PENDING" ? "text-warning" : "text-muted-foreground"}`} aria-hidden />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pedido {order.publicCode}</p>
          <h1 className="font-display text-3xl font-extrabold tracking-tight">
            {order.status === "PAID" ? "Pagamento confirmado!" : order.status === "PENDING_PAYMENT" ? "Aguardando confirmação do pagamento" : st.label}
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

      {order.status === "PENDING_PAYMENT" && (
        <Card className="mt-6 space-y-3 p-5">
          <p className="text-sm">
            Seus ingressos serão emitidos automaticamente quando o provedor confirmar o pagamento. Esta página se atualiza sozinha. A reserva vale até{" "}
            <strong>{formatDateTimeShort(order.expiresAt)}</strong>.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href={`/checkout/${order.id}`} className={buttonVariants({ variant: "secondary" })}>
              Voltar ao pagamento
            </Link>
            <form action={cancelOrderAction.bind(null, order.id)}>
              <button className={buttonVariants({ variant: "ghost" })}>Cancelar pedido</button>
            </form>
          </div>
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
          <OrderSummary items={order.items} subtotalCents={order.subtotalCents} serviceFeeCents={order.serviceFeeCents} totalCents={order.totalCents} />
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
          {eligibility.eligible ? <RefundButton orderId={order.id} /> : !order.refunds.length && <p className="text-sm text-muted-foreground">{eligibility.reason}</p>}
          <p className="text-xs text-muted-foreground">Política do evento: {order.event.refundPolicy}</p>
          <Link href={CANCEL_HELP_HREF} className="inline-block text-sm font-semibold text-secondary hover:underline">
            Cancelar compra / arrependimento: como funciona
          </Link>
        </Card>
      </div>
    </>
  );
}
