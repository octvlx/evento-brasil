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
});
