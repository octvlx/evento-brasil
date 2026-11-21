import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db";
import type { PaymentProviderAdapter } from "@/server/payments/types";
import { handlePaymentWebhook } from "@/server/services/payments";

describe("handlePaymentWebhook", () => {
  it("responde 200 a um aviso que o adaptador manda ignorar, sem tocar no banco nem logar rejeição", async () => {
    const db = new Proxy({}, { get: () => { throw new Error("banco não deve ser usado"); } }) as Db;
    const adapter = { id: "mercadopago", verifyWebhook: async () => ({ valid: false as const, ignore: true, reason: "IPN" }) } as unknown as PaymentProviderAdapter;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const req = { headers: new Headers(), rawBody: "", url: new URL("https://x.test/api/webhooks/mercadopago?id=1&topic=payment") };
    expect(await handlePaymentWebhook(db, adapter, req)).toEqual({ status: 200, body: "ignored" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  function stuckSetup(foreign: boolean | undefined) {
    const update = vi.fn(async () => ({}));
    const db = {
      paymentWebhookEvent: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: "hook" })), update },
      payment: { findFirst: vi.fn(async () => null) },
    } as unknown as Db;
    const adapter = {
      id: "mercadopago",
      verifyWebhook: async () => ({ valid: true as const, externalEventId: "e1", eventType: "payment.created", providerPaymentId: "123", providerAccountId: "999", payload: { user_id: 999 } }),
      getPayment: async () => { throw new Error("sem token para a conta"); },
      ...(foreign === undefined ? {} : { isForeignWebhook: vi.fn(async () => foreign) }),
    } as unknown as PaymentProviderAdapter;
    const req = { headers: new Headers(), rawBody: "", url: new URL("https://x.test/api/webhooks/mercadopago") };
    return { db, adapter, update, req };
  }

  it("marca como ignorado o aviso de conta nunca conectada cujo processamento falhou", async () => {
    const { db, adapter, update, req } = stuckSetup(true);
    expect(await handlePaymentWebhook(db, adapter, req)).toEqual({ status: 200, body: "ignored" });
    expect(update).toHaveBeenLastCalledWith({ where: { id: "hook" }, data: expect.objectContaining({ processingResult: "ignored_unknown_account", processedAt: expect.any(Date), error: null }) });
  });

  it.each([false, undefined])("mantém o erro (500, alerta) quando o aviso não é de conta alheia (%s)", async (foreign) => {
    const { db, adapter, update, req } = stuckSetup(foreign);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await handlePaymentWebhook(db, adapter, req)).toEqual({ status: 500, body: "processing error" });
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date) }) }));
    vi.restoreAllMocks();
  });
});
