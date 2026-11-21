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
import { PaymentNotStartedError, ProviderRejectedError } from "@/server/payments/types";

const db = {
  payment: { findUnique: vi.fn(), findFirst: vi.fn() },
  mercadoPagoAccount: { findFirst: vi.fn() },
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
  it("creates an idempotent PIX-only marketplace preference and returns the init_point checkout URL", async () => {
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
      checkoutUrl: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=live",
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
    expect(body.payer).toEqual({ email: "buyer@example.com" });
  });

  it("opens the sandbox checkout only for sellers connected with TEST- credentials", async () => {
    oauth.getForOrganization.mockResolvedValue("TEST-seller-access-token");
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([{ id: "pix" }]))
      .mockResolvedValueOnce(Response.json({
        id: "preference-123",
        init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=live",
        sandbox_init_point: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=test",
      }));
    const result = await adapter().createPayment(pixInput());
    expect(result.checkoutUrl).toBe("https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=test");
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

  it("refuses PIX before any charge, definitively, when the seller does not have PIX available", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ id: "visa", payment_type_id: "credit_card" }]));
    const error = await adapter().createPayment(pixInput()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentNotStartedError);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", reason: "PIX_UNAVAILABLE", message: expect.stringContaining("não pode receber por PIX") });
    // Só a consulta de métodos; nenhuma preferência foi criada.
    expect(fetch).toHaveBeenCalledTimes(1);
    // Diagnóstico em uma linha de texto (o log do Next mostrava objetos como "{}").
    expect(warning).toHaveBeenCalledWith('[mercadopago] {"phase":"pix_method_unavailable","methods":1}');
  });

  it("card: credit (single installment), debit and prepaid cards, no boleto, even without PIX", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([
        { id: "visa", payment_type_id: "credit_card" },
        { id: "master", payment_type_id: "credit_card" },
        // Mesma bandeira como pré-pago (formato real da API): não pode bloquear o crédito.
        { id: "master", payment_type_id: "prepaid_card" },
        { id: "bolbradesco", payment_type_id: "ticket" },
        { id: "account_money", payment_type_id: "account_money" },
        { id: "debvisa", payment_type_id: "debit_card" },
      ]))
      .mockResolvedValueOnce(Response.json({
        id: "pref-card",
        init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=x",
        sandbox_init_point: "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=x",
      }));
    const result = await adapter().createPayment({ ...pixInput(), method: "CREDIT_CARD" });
    expect(result).toMatchObject({ providerPreferenceId: "pref-card", checkoutUrl: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=x" });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    // Crédito, débito e pré-pago ficam; só o boleto sai. account_money nunca é excluído (400 no Mercado Pago).
    expect(body.payment_methods.excluded_payment_methods).toEqual([{ id: "bolbradesco" }]);
    expect(body.payment_methods.excluded_payment_types).toEqual([{ id: "ticket" }]);
    expect(body.payment_methods.installments).toBe(1);
  });

  it("card: refuses before any charge when the seller has no cards", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ id: "pix", payment_type_id: "bank_transfer" }]));
    await expect(adapter().createPayment({ ...pixInput(), method: "CREDIT_CARD" })).rejects.toMatchObject({ reason: "CARD_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("PIX: checkout with PIX only (cards excluded, balance kept)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json([
        { id: "pix", payment_type_id: "bank_transfer" },
        { id: "visa", payment_type_id: "credit_card" },
        { id: "account_money", payment_type_id: "account_money" },
      ]))
      .mockResolvedValueOnce(Response.json({ id: "pref", init_point: "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=y" }));
    await adapter().createPayment(pixInput());
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(body.payment_methods.excluded_payment_methods).toEqual([{ id: "visa" }]);
    expect(body.payment_methods.excluded_payment_types).toEqual([{ id: "credit_card" }]);
    expect(body.payment_methods.installments).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
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

  it("refund: 400 with a cause is a definitive rejection with only the cause codes; 409 and 5xx stay uncertain", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const refund = () => adapter().refundPayment({ providerPaymentId: "190", amountCents: 100, idempotencyKey: "refund:o1:admin:r1", organizationId: "org-1" }).catch((e: unknown) => e);

    vi.mocked(fetch).mockResolvedValueOnce(Response.json(
      { error: "bad_request", message: "Collector hasn't enough available money", cause: [{ code: 2031, description: "do-not-keep" }] },
      { status: 400 },
    ));
    const rejected = await refund();
    expect(rejected).toBeInstanceOf(ProviderRejectedError);
    expect(rejected).toMatchObject({ code: "PROVIDER_ERROR", httpStatus: 400, causeCodes: ["2031"] });
    expect(JSON.stringify(rejected)).not.toContain("do-not-keep");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://api.mercadopago.com/v1/payments/190/refunds");
    expect(new Headers(init?.headers).get("X-Idempotency-Key")).toBe("refund:o1:admin:r1");
    expect(JSON.parse(String(init?.body))).toEqual({ amount: 1 });

    for (const status of [409, 500]) {
      vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "x" }, { status }));
      const uncertain = await refund();
      expect(uncertain).toMatchObject({ code: "PROVIDER_ERROR" });
      expect(uncertain).not.toBeInstanceOf(ProviderRejectedError);
    }
  });

  it("processing fee is what Mercado Pago kept: charged minus the fee it gave back in refunds, never the commission", async () => {
    // Como o pagamento real 190779304814 depois do estorno integral (R$ 1,00, comissão 0,07, tarifa 0,01).
    const refundedPayment = (mpFeeRefunded: number) => paymentResponse({
      status: "refunded",
      status_detail: "refunded",
      transaction_amount: 1,
      transaction_amount_refunded: 1,
      fee_details: [{ amount: 0.01, type: "mercadopago_fee" }, { amount: 0.07, type: "application_fee" }],
      charges_details: [
        { type: "fee", name: "third_payment", accounts: { from: "collector", to: "marketplace_owner" }, amounts: { original: 0.07, refunded: 0.07 } },
        { type: "fee", name: "mercadopago_fee", accounts: { from: "collector", to: "mp" }, amounts: { original: 0.01, refunded: mpFeeRefunded } },
      ],
    });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(refundedPayment(0.01)));
    expect(await adapter().getPayment("190", { organizationId: "org-1" })).toMatchObject({ status: "REFUNDED", processingFeeCents: 0, refundedCents: 100 });

    // Tarifa ainda não devolvida: continua cobrada; a comissão nunca conta como tarifa.
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(refundedPayment(0)));
    expect(await adapter().getPayment("190", { organizationId: "org-1" })).toMatchObject({ processingFeeCents: 1 });

    // Sem charges_details (provedor não informa): a tarifa cobrada, como antes.
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(paymentResponse()));
    expect(await adapter().getPayment("987", { organizationId: "org-1" })).toMatchObject({ processingFeeCents: 250 });
  });

  it("counts the card advance fee, which only charges_details lists (real payment 189772021215)", async () => {
    // Cartão R$ 1,00: comissão 0,07, tarifa MP 0,02 e antecipação 0,02 (líquido 0,89).
    const card = (refunded: boolean) => paymentResponse({
      status: refunded ? "refunded" : "approved",
      status_detail: refunded ? "refunded" : "accredited",
      transaction_amount: 1,
      transaction_amount_refunded: refunded ? 1 : 0,
      fee_details: [{ amount: 0.02, type: "mercadopago_fee" }, { amount: 0.07, type: "application_fee" }],
      charges_details: [
        { type: "fee", name: "third_payment", accounts: { from: "collector", to: "marketplace_owner" }, amounts: { original: 0.07, refunded: refunded ? 0.07 : 0 } },
        { type: "fee", name: "mercadopago_fee", accounts: { from: "collector", to: "mp" }, amounts: { original: 0.02, refunded: refunded ? 0.02 : 0 } },
        { type: "fee", name: "financed_advance_fee", accounts: { from: "collector", to: "mp" }, amounts: { original: 0.02, refunded: refunded ? 0.02 : 0 } },
      ],
    });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(card(false)));
    expect(await adapter().getPayment("189772021215", { organizationId: "org-1" })).toMatchObject({ status: "PAID", processingFeeCents: 4 });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(card(true)));
    expect(await adapter().getPayment("189772021215", { organizationId: "org-1" })).toMatchObject({ status: "REFUNDED", processingFeeCents: 0 });
  });

  it("falls back to fee_details when a provider fee has no original amount", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(paymentResponse({
      fee_details: [{ amount: 0.03, type: "mercadopago_fee" }],
      charges_details: [{ type: "fee", accounts: { to: "mp" }, amounts: { refunded: 0 } }],
    })));
    expect(await adapter().getPayment("987", { organizationId: "org-1" })).toMatchObject({ processingFeeCents: 3 });
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

  it("ignores the unsigned legacy IPN (?id=&topic=) instead of rejecting it, and still rejects other unsigned calls", async () => {
    const ipn = (query: string) => adapter().verifyWebhook({ headers: new Headers(), rawBody: "", url: new URL(`https://events.example/api/webhooks/mercadopago?${query}`) });
    expect(await ipn("id=187374883982&topic=payment")).toEqual({ valid: false, ignore: true, reason: expect.stringContaining("IPN") });
    expect(await ipn("id=45759762887&topic=merchant_order")).toMatchObject({ valid: false, ignore: true });
    // Sem assinatura e no formato novo: continua recusado (401).
    const unsigned = await ipn("data.id=987&type=payment");
    expect(unsigned).toMatchObject({ valid: false });
    expect(unsigned).not.toHaveProperty("ignore");
  });

  it("does not enable payments without a webhook signing secret", () => {
    expect(adapter("").supportedMethods).toEqual([]);
  });
});

describe("MercadoPagoAdapter.isForeignWebhook", () => {
  const account = (db as unknown as { mercadoPagoAccount: { findFirst: ReturnType<typeof vi.fn> } }).mercadoPagoAccount.findFirst;
  const payment = (db as unknown as { payment: { findFirst: ReturnType<typeof vi.fn> } }).payment.findFirst;
  it.each([
    { name: "conta nunca conectada e pagamento desconhecido", acc: null, pay: null, payload: { user_id: 1608601443 }, expected: true },
    { name: "conta conectada (ou revogada) continua no alerta", acc: { id: "a" }, pay: null, payload: { user_id: 5619907 }, expected: false },
    { name: "pagamento nosso continua no alerta", acc: null, pay: { id: "p" }, payload: { user_id: 1608601443 }, expected: false },
    { name: "sem user_id não é tratado como alheio", acc: null, pay: null, payload: {}, expected: false },
  ])("$name", async ({ acc, pay, payload, expected }) => {
    account.mockResolvedValueOnce(acc);
    payment.mockResolvedValueOnce(pay);
    expect(await adapter().isForeignWebhook({ providerPaymentId: "189772176307", payload })).toBe(expected);
  });

  it("procura a conta sem filtrar revogadas", async () => {
    account.mockResolvedValueOnce(null);
    payment.mockResolvedValueOnce(null);
    await adapter().isForeignWebhook({ providerPaymentId: "1", payload: { user_id: "42" } });
    expect(account).toHaveBeenLastCalledWith({ where: { mercadoPagoUserId: "42" }, select: { id: true } });
  });
});
