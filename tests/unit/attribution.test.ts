import { describe, expect, it } from "vitest";
import { decodeAttribution, encodeAttribution, utmsFromParams } from "@/features/orders/attribution";
import { isCouponError } from "@/features/orders/status-view";

describe("cookie de atribuição", () => {
  it("ida e volta sem campos vazios", () => {
    const raw = encodeAttribution({ trackingLinkId: "clink123", utmSource: "instagram", utmMedium: "" });
    expect(JSON.parse(raw)).toEqual({ trackingLinkId: "clink123", utmSource: "instagram" });
    expect(decodeAttribution(raw)).toEqual({ trackingLinkId: "clink123", utmSource: "instagram" });
  });

  it("valor inválido, adulterado ou grande demais vira sem atribuição", () => {
    expect(decodeAttribution(undefined)).toBeUndefined();
    expect(decodeAttribution("{x")).toBeUndefined();
    expect(decodeAttribution("{}")).toBeUndefined();
    expect(decodeAttribution(JSON.stringify({ trackingLinkId: "<script>" }))).toBeUndefined();
    expect(decodeAttribution(JSON.stringify({ utmSource: "x".repeat(201) }))).toBeUndefined();
    expect(decodeAttribution(JSON.stringify({ utmSource: 7 }))).toBeUndefined();
  });

  it("UTMs soltos: só utm_*, primeiro valor, aparados e cortados em 200", () => {
    expect(utmsFromParams({ q: "show" })).toBeUndefined();
    expect(utmsFromParams({ utm_source: ["  google ", "bing"], utm_term: "x".repeat(300), utm_medium: " " })).toEqual({ utmSource: "google", utmTerm: "x".repeat(200) });
  });
});

describe("erro do cupom", () => {
  it("só quando havia cupom: textos de cupom/desconto e limite de tentativas", () => {
    expect(isCouponError({ error: "Cupom esgotado.", code: "SOLD_OUT" }, true)).toBe(true);
    expect(isCouponError({ error: "Desconto alto demais para este ingresso…", code: "VALIDATION" }, true)).toBe(true);
    expect(isCouponError({ error: "Muitas tentativas.", code: "RATE_LIMITED" }, true)).toBe(true);
    expect(isCouponError({ error: "Capacidade do evento esgotada.", code: "SOLD_OUT" }, true)).toBe(false);
    expect(isCouponError({ error: "Cupom esgotado.", code: "SOLD_OUT" }, false)).toBe(false);
  });
});
