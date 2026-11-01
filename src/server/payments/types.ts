// Contrato neutro de provedor de pagamentos. Nenhum status vindo do cliente
// ou do corpo do webhook é confiável: o sistema sempre consulta `getPayment`.

export type ProviderMethod = "PIX" | "CREDIT_CARD";

export type ProviderPaymentStatus = "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "CANCELLED" | "REFUNDED" | "DISPUTED" | "CHARGED_BACK";

export interface CreatePaymentInput {
  /** Nosso Payment.id — enviado como referência externa. */
  paymentId: string;
  orderId: string;
  amountCents: number;
  method: ProviderMethod;
  description: string;
  payer: { email: string; name: string };
  /** Prazo do provedor alinhado ao fim da reserva de estoque. */
  expiresAt: Date;
  idempotencyKey: string;
  marketplace: {
    organizationId: string;
    /** Conta do organizador no provedor (OAuth). Nulo no simulado. */
    sellerAccountId: string | null;
    /** Comissão a reter via split nativo, quando suportado pelo método. */
    applicationFeeCents: number;
  };
  /** Somente simulado: resultado desejado para cartão. */
  simulatedCardOutcome?: "approve" | "decline";
}

export interface CreatedPayment {
  /** Checkout Pro creates a preference before the buyer creates a payment. */
  providerPaymentId: string | null;
  providerPreferenceId?: string;
  status: ProviderPaymentStatus;
  rawStatus: string;
  pixCopyPaste?: string;
  pixQrCodeBase64?: string;
  checkoutUrl?: string;
  expiresAt?: Date;
}

export interface ProviderPaymentSnapshot {
  providerPaymentId: string;
  externalReference: string;
  status: ProviderPaymentStatus;
  rawStatus: string;
  amountCents: number;
  processingFeeCents: number | null;
  /** Instruções da cobrança existente, inclusive na recuperação por referência. */
  pixCopyPaste?: string;
  pixQrCodeBase64?: string;
  expiresAt?: Date;
}

export interface RefundResult {
  providerRefundId: string;
  status: "SUCCEEDED" | "PENDING" | "FAILED";
}

export interface WebhookRequest {
  headers: Headers;
  rawBody: string;
  url: URL;
}

export type WebhookVerification =
  | { valid: false; reason: string }
  | {
      valid: true;
      externalEventId: string;
      eventType: string;
      providerPaymentId: string | null;
      providerAccountId?: string;
      payload: unknown;
    };

export interface PaymentProviderAdapter {
  readonly id: string;
  readonly isSimulated: boolean;
  readonly supportedMethods: readonly ProviderMethod[];
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  getPayment(providerPaymentId: string, context?: { organizationId?: string; providerAccountId?: string }): Promise<ProviderPaymentSnapshot>;
  refundPayment(input: { providerPaymentId: string; amountCents: number; idempotencyKey: string; organizationId?: string }): Promise<RefundResult>;
  verifyWebhook(req: WebhookRequest): Promise<WebhookVerification>;
  /**
   * Opcional: localiza no provedor um pagamento pela nossa chave de idempotência
   * (referência externa). Usado na reconciliação quando o processo caiu entre a
   * criação no provedor e o registro do id localmente.
   * null significa ausência confirmada, segura para permitir outra cobrança.
   * Resultado inconclusivo/consistência eventual deve lançar erro.
   */
  findPaymentByReference?(idempotencyKey: string): Promise<ProviderPaymentSnapshot | null>;
}
