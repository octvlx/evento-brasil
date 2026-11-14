// Textos do comprador para estados de pagamento e reembolso (seguro para cliente).
// Os estados vêm do servidor; aqui só decidimos o que mostrar.

type Tone = "info" | "success" | "warning" | "danger";

export type CheckoutStep = "choose" | "pix" | "redirect" | "card-processing";

/** O que o checkout mostra a partir das tentativas de pagamento (no máximo uma ativa por pedido). */
export function checkoutStep(payments: { status: string; method: string; checkoutUrl?: string | null }[]): CheckoutStep {
  const active = payments.find((p) => p.status === "PENDING");
  if (!active) return "choose";
  if (active.method === "PIX") return "pix";
  // Cartão pelo Checkout Pro: o pagamento continua na página do Mercado Pago.
  return active.checkoutUrl ? "redirect" : "card-processing";
}

export interface RefundView {
  tone: Tone;
  title: string;
  detail: string;
}

/**
 * Situação do reembolso para o comprador. Os ingressos são cancelados assim que o
 * reembolso é solicitado; se o estorno falhar no provedor, o pedido fica em
 * REFUND_PENDING e a equipe reprocessa — o comprador não precisa pedir de novo.
 */
export function refundView(orderStatus: string, refunds: { status: string; partial?: boolean }[]): RefundView | null {
  const latest = refunds[0];
  // Reembolso parcial com o pedido ainda pago: só os ingressos escolhidos foram cancelados.
  if (latest?.partial && orderStatus === "PAID") {
    if (latest.status === "SUCCEEDED")
      return { tone: "success", title: "Reembolso parcial concluído", detail: "O valor dos ingressos escolhidos foi devolvido pela mesma forma de pagamento. Os demais ingressos continuam válidos." };
    if (latest.status === "FAILED")
      return {
        tone: "warning",
        title: "Reembolso parcial em reprocessamento",
        detail: "O provedor de pagamento não concluiu o estorno na primeira tentativa. Nossa equipe vai reprocessá-lo; não é preciso solicitar de novo. Os ingressos escolhidos continuam cancelados e os demais, válidos.",
      };
    if (latest.status === "REJECTED") return null;
    return { tone: "warning", title: "Reembolso parcial em andamento", detail: "Os ingressos escolhidos já foram cancelados; os demais continuam válidos. Avisaremos por e-mail quando o estorno for concluído." };
  }
  if (orderStatus === "REFUNDED" || latest?.status === "SUCCEEDED") {
    return { tone: "success", title: "Reembolso concluído", detail: "O valor foi devolvido pela mesma forma de pagamento. O prazo para aparecer no extrato depende do seu banco." };
  }
  if (!latest) return null;
  if (latest.status === "FAILED") {
    return {
      tone: "warning",
      title: "Reembolso em reprocessamento",
      detail: "O provedor de pagamento não concluiu o estorno na primeira tentativa. Nossa equipe vai reprocessá-lo; não é preciso solicitar de novo. Os ingressos continuam cancelados.",
    };
  }
  if (latest.status === "REJECTED") {
    return { tone: "danger", title: "Reembolso recusado", detail: "O reembolso não foi aprovado. Fale com o suporte se tiver dúvidas." };
  }
  return {
    tone: "warning",
    title: "Reembolso em andamento",
    detail: "Os ingressos deste pedido já foram cancelados. Avisaremos por e-mail quando o estorno for concluído.",
  };
}

const REVOCATION_TEXT: Record<string, string> = {
  REFUNDED: "Cancelado por reembolso do pedido",
  EVENT_CANCELLED: "Cancelado porque o evento foi cancelado",
  CHARGEBACK: "Cancelado por contestação do pagamento",
  ADMIN: "Cancelado pela equipe da plataforma",
};

export function revocationText(reason: string | null | undefined): string {
  return (reason && REVOCATION_TEXT[reason]) || "Ingresso cancelado";
}

/**
 * Erro de createOrder que é do cupom (exibido junto ao campo do cupom). Os textos
 * vêm do serviço; o limite de tentativas só é aplicado quando há cupom.
 */
export function isCouponError(err: { error: string; code?: string }, sentCoupon: boolean): boolean {
  if (!sentCoupon) return false;
  return err.code === "RATE_LIMITED" || /cupom|desconto/i.test(err.error);
}
