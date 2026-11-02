import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db";

const oauth = vi.hoisted(() => ({
  getForOrganization: vi.fn(async () => "seller-access-token"),
  getForUser: vi.fn(async () => "seller-access-token"),
}));
vi.mock("@/server/env", () => ({
  env: () => ({
    APP_URL: "https://events.example",
    NODE_ENV: "development",
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

const findUnique = vi.fn();
const db = { payment: { findUnique, findFirst: vi.fn() } } as unknown as Db;
const adapter = () => new MercadoPagoAdapter(db, "webhook-secret");

/** Formato real de GET /v1/payments/{id} do Checkout Pro com saldo em conta (dados sanitizados). */
function accountMoneyPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 187330752002,
    status: "approved",
    status_detail: "accredited",
    currency_id: "BRL",
    transaction_amount: 180,
    payment_method_id: "account_money",
    payment_type_id: "account_money",
    external_reference: "local-payment",
    order: { id: "45752367877", type: "mercadopago" },
    date_of_expiration: null,
    merchant_account_id: null,
    fee_details: [
      { amount: 8.98, fee_payer: "collector", type: "mercadopago_fee" },
      { amount: 12.6, fee_payer: "collector", type: "application_fee" },
    ],
    point_of_interaction: { type: "CHECKOUT", transaction_data: { e2e_id: null } },
    ...overrides,
  };
}

const url = (input: unknown) => String(input instanceof Request ? input.url : input);

beforeEach(() => {
  vi.resetAllMocks();
  oauth.getForOrganization.mockResolvedValue("seller-access-token");
  oauth.getForUser.mockResolvedValue("seller-access-token");
  findUnique.mockResolvedValue({ id: "local-payment", providerPreferenceId: "pref-1", order: { organizationId: "org" } });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmação de pagamentos do Checkout Pro", () => {
  it("aceita campos null do Mercado Pago (saldo em conta aprovado sem date_of_expiration)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(accountMoneyPayment()));
    const snapshot = await adapter().getPayment("187330752002", { providerAccountId: "3809512448" });
    expect(snapshot).toMatchObject({
      providerPaymentId: "187330752002",
      externalReference: "local-payment",
      status: "PAID",
      rawStatus: "approved:accredited",
      amountCents: 18000,
      expiresAt: undefined,
      pixCopyPaste: undefined,
    });
  });

  it("taxa de processamento não inclui a comissão da plataforma (application_fee)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(accountMoneyPayment()));
    const snapshot = await adapter().getPayment("187330752002", { organizationId: "org" });
    expect(snapshot.processingFeeCents).toBe(898);
  });

  it("aceita status_detail e fee_details null", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(accountMoneyPayment({ status: "pending", status_detail: null, fee_details: null })));
    const snapshot = await adapter().getPayment("1", { organizationId: "org" });
    expect(snapshot).toMatchObject({ status: "PENDING", rawStatus: "pending", processingFeeCents: null });
  });

  it("encontra o pagamento pela merchant order da preferência mesmo quando a busca de pagamentos não lista nada", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const u = url(input);
      if (u.includes("/merchant_orders/search")) {
        expect(u).toContain("preference_id=pref-1");
        return Response.json({ elements: [{ external_reference: "local-payment", payments: [{ id: 187330752002, status: "approved" }] }] });
      }
      if (u.includes("/v1/payments/search")) return Response.json({ results: [] });
      if (u.endsWith("/v1/payments/187330752002")) return Response.json(accountMoneyPayment());
      throw new Error("unexpected " + u);
    });
    expect(await adapter().findCheckoutPayment("order:CREDIT_CARD:1")).toMatchObject({ providerPaymentId: "187330752002", status: "PAID" });
    expect(await adapter().findPaymentByReference("order:CREDIT_CARD:1")).toMatchObject({ status: "PAID" });
  });

  it("no mesmo checkout, a tentativa aprovada prevalece sobre o cartão recusado", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const u = url(input);
      if (u.includes("/merchant_orders/search")) {
        return Response.json({ elements: [{ external_reference: "local-payment", payments: [{ id: 1, status: "rejected" }, { id: 2, status: "approved" }] }] });
      }
      if (u.endsWith("/v1/payments/1")) return Response.json(accountMoneyPayment({ id: 1, status: "rejected", status_detail: "cc_rejected_other_reason", payment_type_id: "credit_card" }));
      if (u.endsWith("/v1/payments/2")) return Response.json(accountMoneyPayment({ id: 2 }));
      throw new Error("unexpected " + u);
    });
    expect(await adapter().findCheckoutPayment("k")).toMatchObject({ providerPaymentId: "2", status: "PAID" });
  });

  it("ignora merchant orders e pagamentos de outra referência externa", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const u = url(input);
      if (u.includes("/merchant_orders/search")) {
        return Response.json({ elements: [{ external_reference: "other-payment", payments: [{ id: 9 }] }] });
      }
      if (u.includes("/v1/payments/search")) return Response.json({ results: [{ id: 9 }] });
      if (u.endsWith("/v1/payments/9")) return Response.json(accountMoneyPayment({ id: 9, external_reference: "other-payment" }));
      throw new Error("unexpected " + u);
    });
    await expect(adapter().findCheckoutPayment("k")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("checkout sem pagamento: null na consulta da página, mas nunca ausência comprovada com a preferência aberta", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const u = url(input);
      if (u.includes("/merchant_orders/search")) return Response.json({ elements: [] });
      if (u.includes("/v1/payments/search")) return Response.json({ results: [] });
      if (u.includes("/checkout/preferences/")) return Response.json({ external_reference: "local-payment", expiration_date_to: new Date(Date.now() + 60_000).toISOString() });
      throw new Error("unexpected " + u);
    });
    expect(await adapter().findCheckoutPayment("k")).toBeNull();
    await expect(adapter().findPaymentByReference("k")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("falha temporária da API é inconclusiva (erro), nunca 'sem pagamento'", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 503 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(adapter().findCheckoutPayment("k")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("webhook de merchant_order não é tratado como id de pagamento", async () => {
    const requestId = "request-1";
    const ts = "1720000000000";
    const signature = createHmac("sha256", "webhook-secret").update(`id:45752367877;request-id:${requestId};ts:${ts};`).digest("hex");
    const verification = await adapter().verifyWebhook({
      headers: new Headers({ "x-request-id": requestId, "x-signature": `ts=${ts},v1=${signature}` }),
      rawBody: JSON.stringify({ id: 5, type: "topic_merchant_order_wh", user_id: 3809512448, data: { id: "45752367877" } }),
      url: new URL("https://events.example/api/webhooks/mercadopago?data.id=45752367877&type=topic_merchant_order_wh"),
    });
    expect(verification).toMatchObject({ valid: true, providerPaymentId: null });
  });
});
