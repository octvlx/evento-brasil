import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db";

const oauth = vi.hoisted(() => ({
  getForOrganization: vi.fn(async () => "seller-access-token"),
  getForUser: vi.fn(async () => "seller-access-token"),
}));

const envOverrides = vi.hoisted(() => ({}) as { NODE_ENV?: string });
vi.mock("@/server/env", () => ({
  env: () => ({
    APP_URL: "https://events.example",
    NODE_ENV: envOverrides.NODE_ENV ?? "development",
    MERCADO_PAGO_CLIENT_ID: "client-id",
    MERCADO_PAGO_CLIENT_SECRET: "client-secret",
    MERCADO_PAGO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  }),
}));
vi.mock("@/server/payments/mercadopago-oauth", () => ({
  getMercadoPagoAccessToken: oauth.getForOrganization,
  getMercadoPagoAccessTokenForUser: oauth.getForUser,
}));

import { MercadoPagoAdapter } from "@/server/payments/mercadopago";
import { PaymentNotStartedError } from "@/server/payments/types";

const db = {
  payment: { findUnique: vi.fn(), findFirst: vi.fn() },
} as unknown as Db;

function adapter(secret = "webhook-secret") {
  return new MercadoPagoAdapter(db, secret);
}

function paymentResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 987,
    external_reference: "local-payment",
    status: "approved",
    status_detail: "accredited",
    currency_id: "BRL",
    transaction_amount: 50,
    fee_details: [{ amount: 2.5 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  delete envOverrides.NODE_ENV;
  oauth.getForOrganization.mockResolvedValue("seller-access-token");
  oauth.getForUser.mockResolvedValue("seller-access-token");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Mercado Pago Checkout Pro adapter", () => {
  it("creates an idempotent PIX-only marketplace preference and returns sandbox checkout URL", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ id: "pix" }, { id: "visa" }]))
      .mockResolvedValueOnce(Response.json({
        id: "preference-123",
        init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=live",
        sandbox_init_point: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=test",
      }));

    const result = await adapter().createPayment({
      paymentId: "local-payment",
      orderId: "local-order",
      amountCents: 5000,
      method: "PIX",
      description: "Evento",
      payer: { email: "buyer@example.com", name: "Buyer" },
      expiresAt: new Date(Date.now() + 15 * 60_000),
      idempotencyKey: "stable-key",
      marketplace: {
        organizationId: "org-1",
        sellerAccountId: null,
        applicationFeeCents: 500,
      },
    });

    expect(result).toMatchObject({
      providerPaymentId: null,
      providerPreferenceId: "preference-123",
      checkoutUrl: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=test",
      status: "PENDING",
    });
    const [url, init] = vi.mocked(fetch).mock.calls[1];
    expect(String(url)).toBe("https://api.mercadopago.com/checkout/preferences");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer seller-access-token");
    expect(new Headers(init?.headers).get("X-Idempotency-Key")).toBe("stable-key");
    const body = JSON.parse(String(init?.body));
    expect(body.external_reference).toBe("local-payment");
    expect(body.marketplace_fee).toBe(5);
    expect(body.payment_methods.excluded_payment_methods).toEqual([{ id: "visa" }]);
    expect(body.notification_url).toBe("https://events.example/api/webhooks/mercadopago");
  });

  const pixInput = () => ({
    paymentId: "payment",
    orderId: "order",
    amountCents: 1000,
    method: "PIX" as const,
    description: "Event",
    payer: { email: "buyer@example.com", name: "Buyer" },
    expiresAt: new Date(Date.now() + 60_000),
    idempotencyKey: "key",
    marketplace: { organizationId: "org", sellerAccountId: null, applicationFeeCents: 0 },
  });

  it("refuses before any charge, definitively, when a real seller does not have PIX available", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ id: "visa", payment_type_id: "credit_card" }]))
      .mockResolvedValueOnce(Response.json({ id: 1, tags: ["normal"] }));
    const error = await adapter().createPayment(pixInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentNotStartedError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", reason: "PIX_UNAVAILABLE", message: expect.stringContaining("não pode receber por PIX") });
    // Consulta de métodos e da conta; nenhuma preferência foi criada.
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/v1/payment_methods", "/users/me"]);
    // Diagnóstico em uma linha de texto (o log do Next mostrava objetos como "{}").
    expect(warning).toHaveBeenCalledWith('[mercadopago] {"phase":"pix_method_unavailable","methods":1,"sandbox":0}');
  });

  it("sandbox: a test seller without PIX gets a card-only, single-installment checkout", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([
        { id: "visa", payment_type_id: "credit_card" },
        { id: "master", payment_type_id: "credit_card" },
        { id: "bolbradesco", payment_type_id: "ticket" },
        { id: "account_money", payment_type_id: "account_money" },
        { id: "debvisa", payment_type_id: "debit_card" },
      ]))
      .mockResolvedValueOnce(Response.json({ id: 1, tags: ["test_user", "normal"] }))
      .mockResolvedValueOnce(Response.json({
        id: "pref-sandbox",
        init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=x",
        sandbox_init_point: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=x",
      }));
    const result = await adapter().createPayment(pixInput());
    expect(result).toMatchObject({ providerPreferenceId: "pref-sandbox", checkoutUrl: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=x" });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[2][1]?.body));
    expect(body.payment_methods.excluded_payment_methods).toEqual([{ id: "bolbradesco" }, { id: "account_money" }, { id: "debvisa" }]);
    expect(body.payment_methods.installments).toBe(1);
  });

  it("a seller with PIX keeps the PIX-only checkout without checking for a test account", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ id: "pix", payment_type_id: "bank_transfer" }, { id: "visa", payment_type_id: "credit_card" }]))
      .mockResolvedValueOnce(Response.json({ id: "pref", init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=y" }));
    await adapter().createPayment(pixInput());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(body.payment_methods.excluded_payment_methods).toEqual([{ id: "visa" }]);
    expect(body.payment_methods.installments).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("production never relaxes to cards, even for a test seller", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    envOverrides.NODE_ENV = "production";
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ id: "visa", payment_type_id: "credit_card" }]));
    await expect(adapter().createPayment(pixInput())).rejects.toMatchObject({ reason: "PIX_UNAVAILABLE" });
    // Nem consulta a conta: em produção a exceção de sandbox não existe.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses before any charge when the seller account is not usable or the method check fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    oauth.getForOrganization.mockRejectedValueOnce(new Error("revoked"));
    await expect(adapter().createPayment(pixInput())).rejects.toMatchObject({ reason: "ACCOUNT_NOT_CONNECTED" });
    expect(fetch).not.toHaveBeenCalled();

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "unauthorized" }, { status: 401 }));
    await expect(adapter().createPayment(pixInput())).rejects.toMatchObject({ reason: "PRECHECK_FAILED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed preference creation as an uncertain provider error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ id: "pix" }]))
      .mockResolvedValueOnce(Response.json({ error: "internal" }, { status: 500 }));
    const error = await adapter().createPayment(pixInput()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(error).not.toBeInstanceOf(PaymentNotStartedError);
  });

  it("logs safe provider diagnostics without response messages or tokens", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ id: "pix" }]))
      .mockResolvedValueOnce(Response.json(
        { error: "bad_request", message: "private token do-not-log", cause: [{ code: 4021, description: "do-not-log" }] },
        { status: 400, headers: { "x-request-id": "request-safe-id" } },
      ));

    await expect(adapter().createPayment({
      paymentId: "local-payment",
      orderId: "local-order",
      amountCents: 5000,
      method: "PIX",
      description: "Event",
      payer: { email: "buyer@example.com", name: "Buyer" },
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: "stable-key",
      marketplace: { organizationId: "org-1", sellerAccountId: null, applicationFeeCents: 0 },
    })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

    const diagnostic = JSON.stringify(warning.mock.calls);
    expect(diagnostic).toContain("bad_request");
    expect(diagnostic).toContain("4021");
    expect(diagnostic).not.toContain("private token");
    expect(diagnostic).not.toContain("do-not-log");
  });

  it("maps an authoritative payment response and uses the seller account from a verified webhook", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(paymentResponse({
      point_of_interaction: {
        transaction_data: {
          qr_code: "pix-copy-paste",
          qr_code_base64: "cXItY29kZQ==",
          date_of_expiration: "2026-10-31T22:00:00.000Z",
        },
      },
    })));
    const snapshot = await adapter().getPayment("987", { providerAccountId: "12345" });
    expect(oauth.getForUser).toHaveBeenCalledWith(db, "12345");
    expect(snapshot).toMatchObject({
      providerPaymentId: "987",
      externalReference: "local-payment",
      status: "PAID",
      amountCents: 5000,
      processingFeeCents: 250,
      pixCopyPaste: "pix-copy-paste",
      pixQrCodeBase64: "cXItY29kZQ==",
    });
  });

  it("verifies the signed webhook manifest and binds the seller account ID", async () => {
    const requestId = "request-123";
    const timestamp = "1720000000000";
    const manifest = `id:987;request-id:${requestId};ts:${timestamp};`;
    const signature = createHmac("sha256", "webhook-secret").update(manifest).digest("hex");
    const verification = await adapter().verifyWebhook({
      headers: new Headers({
        "x-request-id": requestId,
        "x-signature": `ts=${timestamp},v1=${signature}`,
      }),
      rawBody: JSON.stringify({
        id: 77,
        type: "payment",
        action: "payment.updated",
        user_id: 12345,
        data: { id: "987" },
      }),
      url: new URL("https://events.example/api/webhooks/mercadopago?data.id=987"),
    });
    expect(verification).toMatchObject({
      valid: true,
      providerPaymentId: "987",
      providerAccountId: "12345",
      externalEventId: "77",
    });
  });

  it("does not enable payments without a webhook signing secret", () => {
    expect(adapter("").supportedMethods).toEqual([]);
  });
});
