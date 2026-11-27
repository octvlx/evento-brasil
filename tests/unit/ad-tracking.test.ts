import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasAdTracking } from "@/lib/ad-tracking";
import { adTrackingSchema } from "@/lib/ad-tracking-schema";
import { fireStage, readConsent } from "@/features/tracking/ad-tracking";

describe("formato dos IDs de medição", () => {
  it("aceita os formatos oficiais, tira espaços e transforma vazio em null", () => {
    expect(adTrackingSchema.parse({ metaPixelId: " 1234567890 12345 ", ga4MeasurementId: "G-ABC123XYZ", googleAdsTag: "AW-123456789/AbC-d_EfG" })).toEqual({
      metaPixelId: "123456789012345",
      ga4MeasurementId: "G-ABC123XYZ",
      googleAdsTag: "AW-123456789/AbC-d_EfG",
    });
    expect(adTrackingSchema.parse({ metaPixelId: "", ga4MeasurementId: " ", googleAdsTag: "AW-123456789" })).toEqual({ metaPixelId: null, ga4MeasurementId: null, googleAdsTag: "AW-123456789" });
  });

  it("recusa script, URL e formatos errados", () => {
    for (const bad of [
      { metaPixelId: "<script>", ga4MeasurementId: "", googleAdsTag: "" },
      { metaPixelId: "", ga4MeasurementId: "UA-12345-1", googleAdsTag: "" },
      { metaPixelId: "", ga4MeasurementId: "g-abc123xyz", googleAdsTag: "" },
      { metaPixelId: "", ga4MeasurementId: "", googleAdsTag: "https://evil.test/x" },
      { metaPixelId: "", ga4MeasurementId: "", googleAdsTag: "AW-123456789/\"onload=" },
    ])
      expect(adTrackingSchema.safeParse(bad).success).toBe(false);
  });

  it("hasAdTracking e leitura do cookie de consentimento", () => {
    expect(hasAdTracking({ metaPixelId: null, ga4MeasurementId: null, googleAdsTag: null })).toBe(false);
    expect(hasAdTracking({ metaPixelId: "1234567890", ga4MeasurementId: null, googleAdsTag: null })).toBe(true);
    expect(readConsent("a=1; eb_consent=aceito; b=2")).toBe("aceito");
    expect(readConsent("eb_consent=recusado")).toBe("recusado");
    expect(readConsent("eb_consent=talvez")).toBeNull();
    expect(readConsent("")).toBeNull();
  });
});

describe("eventos disparados", () => {
  const ids = { metaPixelId: "123456789012345", ga4MeasurementId: "G-ABC123XYZ", googleAdsTag: "AW-123456789/Rotulo1" };
  const fbq = vi.fn();
  const gtag = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("window", { fbq, gtag });
    fbq.mockReset();
    gtag.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("visita e início da compra com valor em reais e o id do evento", () => {
    fireStage(ids, { kind: "view", eventId: "ev1", valueCents: 4000 }, null);
    expect(fbq).toHaveBeenCalledWith("track", "ViewContent", { currency: "BRL", value: 40, content_ids: ["ev1"], content_type: "product" });
    expect(gtag).toHaveBeenCalledWith("event", "view_item", { currency: "BRL", value: 40, items: [{ item_id: "ev1" }] });
    fireStage(ids, { kind: "checkout", eventId: "ev1", valueCents: 8560 }, null);
    expect(fbq).toHaveBeenCalledWith("track", "InitiateCheckout", expect.objectContaining({ value: 85.6 }));
    expect(gtag).toHaveBeenCalledWith("event", "begin_checkout", expect.objectContaining({ value: 85.6 }));
  });

  it("compra: Meta com eventID do pedido, GA4 e conversão do Ads; uma vez por pedido; sem dado pessoal", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const stage = { kind: "purchase" as const, eventId: "ev1", orderId: "ord1", publicCode: "EB-ABC123", valueCents: 12000 };
    expect(fireStage(ids, stage, storage)).toBe(true);
    expect(fbq).toHaveBeenCalledWith("track", "Purchase", { currency: "BRL", value: 120, content_ids: ["ev1"], content_type: "product" }, { eventID: "ord1" });
    expect(gtag).toHaveBeenCalledWith("event", "purchase", { currency: "BRL", value: 120, transaction_id: "EB-ABC123", items: [{ item_id: "ev1" }] });
    expect(gtag).toHaveBeenCalledWith("event", "conversion", { currency: "BRL", value: 120, send_to: "AW-123456789/Rotulo1", transaction_id: "EB-ABC123" });
    const calls = fbq.mock.calls.length + gtag.mock.calls.length;
    expect(fireStage(ids, stage, storage)).toBe(false);
    expect(fbq.mock.calls.length + gtag.mock.calls.length).toBe(calls);
    expect(JSON.stringify([...fbq.mock.calls, ...gtag.mock.calls])).not.toMatch(/@|cpf|email/i);
  });

  it("só dispara nas ferramentas configuradas; Ads sem rótulo não registra conversão", () => {
    fireStage({ metaPixelId: null, ga4MeasurementId: null, googleAdsTag: "AW-123456789" }, { kind: "purchase", eventId: "e", orderId: "o", publicCode: "P", valueCents: 100 }, null);
    expect(fbq).not.toHaveBeenCalled();
    expect(gtag.mock.calls.map((c) => c[1])).toEqual(["purchase"]);
  });
});
