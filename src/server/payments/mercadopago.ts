import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db";
import { safeEqual } from "../crypto";
import { env } from "../env";
import { AppError } from "../errors";
import {
  getMercadoPagoAccessToken,
  getMercadoPagoAccessTokenForUser,
} from "./mercadopago-oauth";
import {
  PaymentNotStartedError,
  type CreatePaymentInput,
  type PaymentProviderAdapter,
  type ProviderPaymentSnapshot,
  type ProviderPaymentStatus,
  type RefundResult,
  type WebhookRequest,
  type WebhookVerification,
} from "./types";

const API = "https://api.mercadopago.com";
const providerError = () =>
  new AppError("PROVIDER_ERROR", "Não foi possível concluir a operação com o Mercado Pago.");
function providerDiagnostic(
  phase: string,
  details: Record<string, string | number | undefined>,
) {
  // Uma linha de texto: o log de desenvolvimento do Next serializa objetos como "{}".
  console.warn(`[mercadopago] ${JSON.stringify({ phase, ...details })}`);
}
function safeDiagnosticCode(value: string | number | undefined) {
  const text = value === undefined ? undefined : String(value);
  return text && /^[A-Za-z0-9_.-]{1,80}$/.test(text) ? text : undefined;
}
const methodsSchema = z.array(z.object({ id: z.string(), payment_type_id: z.string().optional() }));
type SellerMethod = z.infer<typeof methodsSchema>[number];

/**
 * Métodos do Mercado Pago aceitos para o método escolhido no site: PIX → só PIX;
 * cartão → crédito (à vista), débito e pré-pago. Boleto fica de fora (compensação
 * de dias não cabe na reserva de 15 minutos).
 * O saldo em conta (`account_money`) não pode ser excluído e sempre aparece.
 */
export const CARD_PAYMENT_TYPES = ["credit_card", "debit_card", "prepaid_card"] as const;
export function allowedCheckoutMethods(methods: SellerMethod[], method: "PIX" | "CREDIT_CARD") {
  return methods.filter((m) =>
    method === "PIX" ? m.id === "pix" : (CARD_PAYMENT_TYPES as readonly string[]).includes(m.payment_type_id ?? ""),
  );
}

/**
 * Exclusões da preferência para que só os métodos permitidos apareçam.
 * - A mesma bandeira aparece com tipos diferentes (ex.: `master` crédito e `master`
 *   pré-pago): excluir o id `master` bloquearia o crédito também. Por isso a bandeira
 *   só é excluída quando nenhuma variante dela é permitida, e o tipo indesejado
 *   (pré-pago, débito, boleto…) é excluído por `excluded_payment_types`.
 * - O Mercado Pago recusa a preferência (400 "account_money cannot be excluded")
 *   se o saldo em conta for excluído: ele fica sempre disponível.
 */
export function checkoutExclusions(methods: SellerMethod[], allowed: SellerMethod[]) {
  const allowedIds = new Set(allowed.map((method) => method.id));
  const allowedTypes = new Set(allowed.map((method) => method.payment_type_id));
  const ids = new Set(methods.map((method) => method.id).filter((id) => !allowedIds.has(id) && id !== "account_money"));
  const types = new Set(
    methods
      .map((method) => method.payment_type_id)
      .filter((type): type is string => !!type && !allowedTypes.has(type) && type !== "account_money"),
  );
  return {
    excluded_payment_methods: [...ids].map((id) => ({ id })),
    excluded_payment_types: [...types].map((id) => ({ id })),
  };
}

/**
 * Para a tela do organizador: o que a conta conectada consegue receber pelo checkout?
 * Só leitura. null = não foi possível verificar agora (sem conta, rede, resposta inválida).
 */
export async function sellerCheckoutReadiness(db: Db, organizationId: string): Promise<{ pix: boolean; card: boolean } | null> {
  try {
    const token = await getMercadoPagoAccessToken(db, organizationId);
    const methods = methodsSchema.safeParse(await requestJson("/v1/payment_methods", token));
    if (!methods.success) return null;
    return {
      pix: allowedCheckoutMethods(methods.data, "PIX").length > 0,
      card: allowedCheckoutMethods(methods.data, "CREDIT_CARD").length > 0,
    };
  } catch {
    return null;
  }
}
const amount = (cents: number) => Number((cents / 100).toFixed(2));
const cents = (value: number) => Math.round(value * 100);
function providerDate(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw providerError();
  return date;
}

const preferenceSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  init_point: z.string().url(),
  sandbox_init_point: z.string().url().optional(),
  expiration_date_to: z.string().optional(),
});

const paymentSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  external_reference: z.string().min(1),
  status: z.string().min(1),
  status_detail: z.string().optional(),
  currency_id: z.literal("BRL"),
  transaction_amount: z.number().nonnegative(),
  date_of_expiration: z.string().optional(),
  fee_details: z.array(z.object({ amount: z.number().nonnegative() })).optional(),
  point_of_interaction: z.object({
    transaction_data: z.object({
      qr_code: z.string().optional(),
      qr_code_base64: z.string().optional(),
      date_of_expiration: z.string().optional(),
    }).optional(),
  }).optional(),
});
const webhookPayloadSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  action: z.string().optional(),
  user_id: z.union([z.string(), z.number()]).optional(),
  data: z.object({ id: z.union([z.string(), z.number()]).optional() }).optional(),
});

async function requestJson(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, API), {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    providerDiagnostic("request_failed", {
      path,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    throw providerError();
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = z.object({
      error: z.string().optional(),
      cause: z.array(z.object({ code: z.union([z.string(), z.number()]).optional() })).optional(),
    }).safeParse(body);
    providerDiagnostic("request_rejected", {
      path,
      status: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined,
      errorCode: parsedError.success
        ? safeDiagnosticCode(parsedError.data.error)
        : undefined,
      causeCodes: parsedError.success
        ? parsedError.data.cause
            ?.map((cause) => safeDiagnosticCode(cause.code) ?? "unknown")
            .join(",")
        : undefined,
    });
    throw providerError();
  }
  return body;
}

function mapStatus(status: string, detail: string | undefined): ProviderPaymentStatus {
  switch (status) {
    case "approved":
      return "PAID";
    case "pending":
    case "in_process":
    case "authorized":
      return "PENDING";
    case "in_mediation":
      return "DISPUTED";
    case "rejected":
      return "FAILED";
    case "cancelled":
      return detail === "expired" ? "EXPIRED" : "CANCELLED";
    case "refunded":
      return "REFUNDED";
    case "charged_back":
      return "CHARGED_BACK";
    default:
      throw providerError();
  }
}

function toSnapshot(raw: unknown): ProviderPaymentSnapshot {
  const parsed = paymentSchema.safeParse(raw);
  if (!parsed.success) throw providerError();
  const payment = parsed.data;
  const fees = payment.fee_details;
  const expiration = payment.point_of_interaction?.transaction_data?.date_of_expiration ?? payment.date_of_expiration;
  return {
    providerPaymentId: payment.id,
    externalReference: payment.external_reference,
    status: mapStatus(payment.status, payment.status_detail),
    rawStatus: payment.status_detail
      ? `${payment.status}:${payment.status_detail}`
      : payment.status,
    amountCents: cents(payment.transaction_amount),
    processingFeeCents: fees ? fees.reduce((total, fee) => total + cents(fee.amount), 0) : null,
    pixCopyPaste: payment.point_of_interaction?.transaction_data?.qr_code,
    pixQrCodeBase64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
    expiresAt: providerDate(expiration),
  };
}

export class MercadoPagoAdapter implements PaymentProviderAdapter {
  readonly id = "mercadopago";
  readonly isSimulated = false;
  readonly supportedMethods: readonly ("PIX" | "CREDIT_CARD")[];

  constructor(
    private readonly db: Db,
    private readonly webhookSecret: string | undefined,
  ) {
    const e = env();
    const key = e.MERCADO_PAGO_TOKEN_ENCRYPTION_KEY;
    const validKey = !!key && Buffer.from(key, "base64").length === 32;
    this.supportedMethods =
      e.MERCADO_PAGO_CLIENT_ID &&
      e.MERCADO_PAGO_CLIENT_SECRET &&
      validKey &&
      webhookSecret
        ? ["PIX", "CREDIT_CARD"]
        : [];
  }

  async createPayment(input: CreatePaymentInput) {
    if (
      !this.supportedMethods.includes(input.method) ||
      !input.marketplace.organizationId ||
      input.amountCents <= 0 ||
      input.expiresAt <= new Date()
    ) {
      throw providerError();
    }

    // Verificações prévias: nada aqui pode criar cobrança, então uma recusa é definitiva.
    let accessToken: string;
    try {
      accessToken = await getMercadoPagoAccessToken(this.db, input.marketplace.organizationId);
    } catch {
      providerDiagnostic("seller_account_unavailable", {});
      throw new PaymentNotStartedError(
        "ACCOUNT_NOT_CONNECTED",
        "O organizador deste evento ainda não está com a conta de recebimento ativa. Tente novamente mais tarde ou fale com o organizador.",
      );
    }
    let rawMethods: unknown;
    try {
      rawMethods = await requestJson("/v1/payment_methods", accessToken);
    } catch {
      throw new PaymentNotStartedError("PRECHECK_FAILED", "Não foi possível iniciar o pagamento agora. Tente novamente em instantes.");
    }
    const methods = methodsSchema.safeParse(rawMethods);
    if (!methods.success) {
      providerDiagnostic("invalid_payment_methods_response", {});
      throw new PaymentNotStartedError("PRECHECK_FAILED", "Não foi possível iniciar o pagamento agora. Tente novamente em instantes.");
    }
    const card = input.method === "CREDIT_CARD";
    const allowed = allowedCheckoutMethods(methods.data, input.method);
    if (allowed.length === 0) {
      providerDiagnostic(card ? "card_method_unavailable" : "pix_method_unavailable", { methods: methods.data.length });
      throw card
        ? new PaymentNotStartedError("CARD_UNAVAILABLE", "O organizador deste evento ainda não pode receber por cartão. Tente pagar com PIX ou fale com o organizador.")
        : new PaymentNotStartedError("PIX_UNAVAILABLE", "O organizador deste evento ainda não pode receber por PIX. Tente novamente mais tarde ou fale com o organizador.");
    }

    const appUrl = new URL(env().APP_URL);
    const returnUrl = new URL(`/pedido/${encodeURIComponent(input.orderId)}`, appUrl).href;
    const now = new Date();
    const body = {
      items: [{
        id: input.paymentId,
        title: input.description.slice(0, 256),
        quantity: 1,
        currency_id: "BRL",
        unit_price: amount(input.amountCents),
      }],
      payer: { email: input.payer.email },
      external_reference: input.paymentId,
      marketplace_fee: amount(input.marketplace.applicationFeeCents),
      payment_methods: {
        ...checkoutExclusions(methods.data, allowed),
        // Cartão só à vista: parcelado com juros mudaria o valor pago em relação ao pedido.
        ...(card ? { installments: 1 } : {}),
        // Debito/pré-pago não parcelam; o limite acima vale para o crédito.
      },
      notification_url: new URL("/api/webhooks/mercadopago", appUrl).href,
      back_urls: {
        success: returnUrl,
        pending: returnUrl,
        failure: returnUrl,
      },
      auto_return: "approved",
      expires: true,
      expiration_date_from: now.toISOString(),
      expiration_date_to: input.expiresAt.toISOString(),
    };
    const raw = await requestJson("/checkout/preferences", accessToken, {
      method: "POST",
      headers: { "X-Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify(body),
    });
    const parsed = preferenceSchema.safeParse(raw);
    if (!parsed.success) {
      providerDiagnostic("invalid_preference_response", {
        fields: parsed.error.issues.map((issue) => issue.path.join(".")).join(","),
      });
      throw providerError();
    }
    for (const checkoutUrl of [parsed.data.init_point, parsed.data.sandbox_init_point].filter(Boolean)) {
      const host = new URL(checkoutUrl!).hostname;
      if (!["www.mercadopago.com.br", "mercadopago.com.br", "sandbox.mercadopago.com.br"].includes(host)) {
        throw providerError();
      }
    }
    const e = env();
    const checkoutUrl =
      e.NODE_ENV === "production"
        ? parsed.data.init_point
        : parsed.data.sandbox_init_point ?? parsed.data.init_point;
    return {
      providerPaymentId: null,
      providerPreferenceId: parsed.data.id,
      status: "PENDING" as const,
      rawStatus: "preference_created",
      checkoutUrl,
      expiresAt: providerDate(parsed.data.expiration_date_to) ?? input.expiresAt,
    };
  }

  async getPayment(
    providerPaymentId: string,
    context: { organizationId?: string; providerAccountId?: string } = {},
  ) {
    const accessToken = context.providerAccountId
      ? await getMercadoPagoAccessTokenForUser(this.db, context.providerAccountId)
      : context.organizationId
        ? await getMercadoPagoAccessToken(this.db, context.organizationId)
        : await this.accessTokenForPayment(providerPaymentId);
    const raw = await requestJson(
      `/v1/payments/${encodeURIComponent(providerPaymentId)}`,
      accessToken,
    );
    return toSnapshot(raw);
  }

  async findPaymentByReference(idempotencyKey: string) {
    const payment = await this.db.payment.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        providerPreferenceId: true,
        order: { select: { organizationId: true } },
      },
    });
    if (!payment || !payment.providerPreferenceId) throw providerError();
    const accessToken = await getMercadoPagoAccessToken(
      this.db,
      payment.order.organizationId,
    );
    const search = z.object({
      results: z.array(z.unknown()),
    }).safeParse(await requestJson(
      `/v1/payments/search?external_reference=${encodeURIComponent(payment.id)}&limit=2`,
      accessToken,
    ));
    if (!search.success) throw providerError();
    if (search.data.results.length > 1) throw providerError();
    if (search.data.results.length === 1) return toSnapshot(search.data.results[0]);

    const preference = z.object({
      external_reference: z.string(),
      expiration_date_to: z.string().optional(),
    }).safeParse(await requestJson(
      `/checkout/preferences/${encodeURIComponent(payment.providerPreferenceId)}`,
      accessToken,
    ));
    if (!preference.success || preference.data.external_reference !== payment.id) {
      throw providerError();
    }
    const expiresAt = providerDate(preference.data.expiration_date_to);
    if (!expiresAt || Date.now() <= expiresAt.getTime() + 24 * 60 * 60 * 1000) {
      throw providerError();
    }
    return null;
  }

  async refundPayment(input: {
    providerPaymentId: string;
    amountCents: number;
    idempotencyKey: string;
    organizationId?: string;
  }): Promise<RefundResult> {
    if (!input.organizationId || input.amountCents <= 0) throw providerError();
    const accessToken = await getMercadoPagoAccessToken(this.db, input.organizationId);
    const raw = await requestJson(
      `/v1/payments/${encodeURIComponent(input.providerPaymentId)}/refunds`,
      accessToken,
      {
        method: "POST",
        headers: { "X-Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify({ amount: amount(input.amountCents) }),
      },
    );
    const result = z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      status: z.enum(["approved", "pending", "rejected"]),
    }).safeParse(raw);
    if (!result.success) throw providerError();
    return {
      providerRefundId: result.data.id,
      status:
        result.data.status === "approved"
          ? "SUCCEEDED"
          : result.data.status === "pending"
            ? "PENDING"
            : "FAILED",
    };
  }

  async verifyWebhook(req: WebhookRequest): Promise<WebhookVerification> {
    if (!this.webhookSecret) {
      return { valid: false, reason: "MERCADO_PAGO_WEBHOOK_SECRET não configurado" };
    }
    const signature = req.headers.get("x-signature");
    const requestId = req.headers.get("x-request-id");
    const dataId = req.url.searchParams.get("data.id");
    if (!signature || !requestId || !dataId) {
      return { valid: false, reason: "assinatura ou identificadores ausentes" };
    }
    const parts = new Map<string, string>();
    for (const component of signature.split(",")) {
      const separator = component.indexOf("=");
      if (separator <= 0) continue;
      const key = component.slice(0, separator).trim();
      const value = component.slice(separator + 1).trim();
      if (parts.has(key)) return { valid: false, reason: "assinatura malformada" };
      parts.set(key, value);
    }
    const timestamp = parts.get("ts");
    const signatureValue = parts.get("v1");
    if (!timestamp || !signatureValue) {
      return { valid: false, reason: "assinatura malformada" };
    }
    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
    const expected = createHmac("sha256", this.webhookSecret).update(manifest).digest("hex");
    if (!safeEqual(signatureValue, expected)) {
      return { valid: false, reason: "assinatura inválida" };
    }

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(req.rawBody);
    } catch {
      return { valid: false, reason: "corpo inválido" };
    }
    const parsedPayload = webhookPayloadSchema.safeParse(rawPayload);
    if (!parsedPayload.success) return { valid: false, reason: "corpo inválido" };
    const payload = parsedPayload.data;
    if (payload.user_id === undefined) {
      return { valid: false, reason: "conta do vendedor ausente" };
    }
    if (payload.data?.id && String(payload.data.id).toLowerCase() !== dataId.toLowerCase()) {
      return { valid: false, reason: "id do evento divergente" };
    }
    return {
      valid: true,
      externalEventId: String(payload.id ?? `${dataId}:${timestamp}`),
      eventType: payload.action ?? payload.type ?? "unknown",
      providerPaymentId: dataId,
      providerAccountId: String(payload.user_id),
      payload,
    };
  }

  private async accessTokenForPayment(providerPaymentId: string) {
    const payment = await this.db.payment.findFirst({
      where: { provider: this.id, providerPaymentId },
      select: { order: { select: { organizationId: true } } },
    });
    if (!payment) throw providerError();
    return getMercadoPagoAccessToken(this.db, payment.order.organizationId);
  }
}
