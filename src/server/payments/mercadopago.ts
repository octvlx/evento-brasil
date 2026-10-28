// Mercado Pago — ESQUELETO DESABILITADO.
//
// Nenhuma chamada de API foi implementada porque os contratos (OAuth de
// marketplace, split com application_fee, PIX no fluxo de marketplace,
// reembolsos, formato de notificações e liquidação) ainda não foram
// verificados na documentação oficial vigente nem com a conta comercial.
// Ver docs/payments-mercadopago.md para a lista de verificação.
//
// A única parte esboçada é a verificação de assinatura de webhook, baseada no
// esquema público "x-signature" (ts/v1 + manifesto id/request-id/ts com
// HMAC-SHA256). Também precisa ser confirmada antes de habilitar.
import "server-only";
import { createHmac } from "node:crypto";
import { AppError } from "../errors";
import { safeEqual } from "../crypto";
import type { PaymentProviderAdapter, WebhookRequest, WebhookVerification } from "./types";

const notEnabled = () =>
  new AppError("PROVIDER_ERROR", "Integração com Mercado Pago ainda não habilitada: contratos de API pendentes de verificação.");

export class MercadoPagoAdapter implements PaymentProviderAdapter {
  readonly id = "mercadopago";
  readonly isSimulated = false;
  readonly supportedMethods = [] as const;

  constructor(private readonly webhookSecret: string | undefined) {}

  async createPayment(): Promise<never> {
    throw notEnabled();
  }

  async getPayment(): Promise<never> {
    throw notEnabled();
  }

  async refundPayment(): Promise<never> {
    throw notEnabled();
  }

  async verifyWebhook(req: WebhookRequest): Promise<WebhookVerification> {
    if (!this.webhookSecret) return { valid: false, reason: "MERCADO_PAGO_WEBHOOK_SECRET não configurado" };
    const header = req.headers.get("x-signature");
    const requestId = req.headers.get("x-request-id") ?? "";
    const dataId = req.url.searchParams.get("data.id") ?? "";
    if (!header || !dataId) return { valid: false, reason: "assinatura ou data.id ausente" };
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=") as [string, string]));
    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
    const expected = createHmac("sha256", this.webhookSecret).update(manifest).digest("hex");
    if (!parts.v1 || !safeEqual(parts.v1, expected)) return { valid: false, reason: "assinatura inválida" };
    let payload: { id?: string | number; type?: string; action?: string };
    try {
      payload = JSON.parse(req.rawBody);
    } catch {
      return { valid: false, reason: "corpo inválido" };
    }
    return {
      valid: true,
      externalEventId: String(payload.id ?? `${dataId}:${parts.ts}`),
      eventType: payload.action ?? payload.type ?? "unknown",
      providerPaymentId: dataId,
      payload,
    };
  }
}
