import { describe, expect, it } from "vitest";
import { formatBRL } from "@/lib/money";
import { feeBreakdownText, priceLabel } from "@/lib/price-display";
import { minPriceQuote, quoteUnitPrice } from "@/server/services/catalog";

const buyerRule = { policyVersion: "t:v1", percentBps: 1000, fixedCentsPerTicket: 0, bearer: "BUYER" as const };
const organizerRule = { ...buyerRule, bearer: "ORGANIZER" as const };

describe("preço total por ingresso (Decreto 13.108/2026, R1)", () => {
  it("cota com a taxa do comprador e discrimina a taxa", () => {
    const q = quoteUnitPrice(10000, buyerRule);
    expect(q).toEqual({ priceCents: 10000, serviceFeeCents: 1000, totalCents: 11000 });
    expect(priceLabel(q)).toEqual({ label: `A partir de ${formatBRL(11000)}`, detail: `(${formatBRL(10000)} + ${formatBRL(1000)} de taxa)` });
    expect(feeBreakdownText(q)).toBe(`${formatBRL(10000)} + ${formatBRL(1000)} de taxa`);
  });

  it("taxa assumida pelo organizador não aparece; gratuito continua Gratuito", () => {
    const q = quoteUnitPrice(10000, organizerRule);
    expect(q.serviceFeeCents).toBe(0);
    expect(priceLabel(q)).toEqual({ label: `A partir de ${formatBRL(10000)}`, detail: null });
    expect(priceLabel(quoteUnitPrice(0, buyerRule))).toEqual({ label: "Gratuito", detail: null });
    expect(priceLabel(null).label).toBe("Ingressos em breve");
  });

  it("menor total entre os tipos", () => {
    expect(minPriceQuote([8000, 0, 3000], buyerRule)?.totalCents).toBe(0);
    expect(minPriceQuote([8000, 3000], buyerRule)).toEqual({ priceCents: 3000, serviceFeeCents: 300, totalCents: 3300 });
    expect(minPriceQuote([], buyerRule)).toBeNull();
  });
});
