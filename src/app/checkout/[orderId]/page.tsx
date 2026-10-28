import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import QRCode from "qrcode";
import { CalendarDays, FlaskConical } from "lucide-react";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { OrderSummary } from "@/components/site/order-summary";
import { CheckoutPanel } from "@/features/orders/checkout-panel";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { getOrderForBuyer } from "@/server/services/orders";
import { checkoutStep } from "@/features/orders/status-view";
import { formatEventDateTime } from "@/lib/datetime";
import { getPaymentAdapter } from "@/server/payments";
import { pendingTermsKinds } from "@/server/services/terms";

export const metadata: Metadata = { title: "Pagamento", robots: { index: false } };

export default function CheckoutPage({ params }: PageProps<"/checkout/[orderId]">) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">Pagamento</h1>
      <Suspense fallback={<Skeleton className="mt-6 h-96" />}>
        <Checkout params={params} />
      </Suspense>
    </div>
  );
}

async function Checkout({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const user = await requireUser(`/checkout/${orderId}`);
  const order = await getOrderForBuyer(db, user, orderId);
  if (order.status !== "PENDING_PAYMENT") redirect(`/pedido/${orderId}`);
  const step = checkoutStep(order.payments);
  const termsPending = (await pendingTermsKinds(db, user.id)).length > 0;
  const confirmingPayment = order.payments.some((p) => p.status === "PENDING" && (!p.providerPaymentId || (p.method === "PIX" && !p.pixCopyPaste && !p.pixQrCodeBase64)));
  const pix = step === "pix" ? order.payments.find((p) => p.status === "PENDING" && p.method === "PIX") : undefined;
  // Para PIX real o provedor envia o QR; no simulado geramos o QR do texto "SIMULADO".
  const qrDataUrl = pix?.pixQrCodeBase64
    ? `data:image/png;base64,${pix.pixQrCodeBase64}`
    : pix?.pixCopyPaste
      ? await QRCode.toDataURL(pix.pixCopyPaste, { margin: 1, width: 448 })
      : null;
  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        {order.isSimulated && (
          <Alert variant="warning" className="flex gap-2">
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              <strong>Pagamento simulado.</strong> Este pedido usa o provedor de testes. Não pague o código PIX exibido — ele não é real.
            </span>
          </Alert>
        )}
        {getPaymentAdapter().supportedMethods.length === 0 ? (
          <Alert variant="warning">O pagamento está temporariamente indisponível. Nenhuma nova cobrança será iniciada.</Alert>
        ) : confirmingPayment ? (
          <Alert variant="warning">Estamos confirmando seu pagamento. Acompanhe o pedido antes de tentar novamente.</Alert>
        ) : <CheckoutPanel
          orderId={order.id}
          expiresAt={order.expiresAt.toISOString()}
          isSimulated={order.isSimulated}
          pendingPix={pix ? { copyPaste: pix.pixCopyPaste, qrDataUrl } : null}
          cardProcessing={step === "card-processing"}
          termsPending={termsPending}
        />}
      </div>
      <Card className="h-fit p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pedido {order.publicCode}</p>
        <h2 className="mt-1 font-display text-lg font-bold">{order.event.title}</h2>
        <p className="mb-4 mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <CalendarDays className="size-4" aria-hidden /> {formatEventDateTime(order.event.startsAt, order.event.timezone)}
        </p>
        <OrderSummary items={order.items} subtotalCents={order.subtotalCents} serviceFeeCents={order.serviceFeeCents} totalCents={order.totalCents} discountCents={order.discountCents} couponCode={order.couponCode} />
        <p className="mt-4 text-xs text-muted-foreground">
          Vendido por {order.event.organization.name}. A plataforma intermedeia a venda; a realização do evento é responsabilidade do organizador.
        </p>
      </Card>
    </div>
  );
}
