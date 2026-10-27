// Desconto de cupom (ADR 0002, D1/D2) e computeFees com desconto.
import { describe, expect, it } from "vitest";
import { discountPerUnit, undercutHalfPrice } from "@/features/fees/discount";
import { computeFees, lineWithNegativePayout } from "@/features/fees/policy";

const pct = (bps: number) => ({ discountType: "PERCENT" as const, percentBps: bps, amountCents: null });
const fixed = (cents: number) => ({ discountType: "FIXED_PER_TICKET" as const, percentBps: null, amountCents: cents });
const rule = { policyVersion: "t:v1", percentBps: 1000, fixedCentsPerTicket: 0, bearer: "ORGANIZER" as const };

describe("discountPerUnit", () => {
  it("percentual arredonda o desconto meia-para-cima", () => {
    expect(discountPerUnit(10000, pct(1000))).toBe(1000);
    expect(discountPerUnit(1005, pct(1000))).toBe(101); // 100,5 → 101
    expect(discountPerUnit(1004, pct(1000))).toBe(100); // 100,4 → 100
  });

  it("100% zera o preço; nunca passa do preço", () => {
    expect(discountPerUnit(4990, pct(10000))).toBe(4990);
    expect(discountPerUnit(1, pct(9999))).toBe(1);
  });

  it("fixo é limitado ao preço", () => {
    expect(discountPerUnit(10000, fixed(1500))).toBe(1500);
    expect(discountPerUnit(1000, fixed(1500))).toBe(1000);
  });

  it("ingresso gratuito não recebe desconto", () => {
    expect(discountPerUnit(0, pct(5000))).toBe(0);
    expect(discountPerUnit(0, fixed(500))).toBe(0);
  });

  it("recusa preço ou cupom inválidos", () => {
    expect(() => discountPerUnit(-1, pct(1000))).toThrow(RangeError);
    expect(() => discountPerUnit(100, { discountType: "PERCENT", percentBps: null, amountCents: null })).toThrow(RangeError);
    expect(() => discountPerUnit(100, { discountType: "FIXED_PER_TICKET", percentBps: null, amountCents: 0 })).toThrow(RangeError);
  });
});

describe("computeFees com desconto", () => {
  it("comissão e taxa incidem sobre o preço líquido; subtotal já é líquido", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 10000, quantity: 2, discountPerUnitCents: 2000 }], rule);
    expect(f.lines[0]).toMatchObject({ listUnitPriceCents: 10000, discountPerUnitCents: 2000, unitPriceCents: 8000, lineDiscountCents: 4000, commissionPerUnitCents: 800 });
    expect(f).toMatchObject({ subtotalCents: 16000, discountCents: 4000, totalCents: 16000, commissionCents: 1600, organizerShareCents: 14400 });
  });

  it("bearer BUYER: taxa de serviço sobre o líquido", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 10000, quantity: 1, discountPerUnitCents: 5000 }], { ...rule, bearer: "BUYER" });
    expect(f).toMatchObject({ subtotalCents: 5000, serviceFeeCents: 500, totalCents: 5500, discountCents: 5000 });
  });

  it("cupom de 100% gera linha gratuita sem comissão, mesmo com taxa fixa", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 10000, quantity: 3, discountPerUnitCents: 10000 }], { ...rule, fixedCentsPerTicket: 200 });
    expect(f).toMatchObject({ totalCents: 0, commissionCents: 0, discountCents: 30000 });
  });

  it("pedido misto: uma linha zerada pelo cupom, outra paga sem desconto", () => {
    const f = computeFees(
      [
        { ticketTypeId: "a", unitPriceCents: 5000, quantity: 1, discountPerUnitCents: 5000 },
        { ticketTypeId: "b", unitPriceCents: 3000, quantity: 2 },
      ],
      rule,
    );
    expect(f).toMatchObject({ subtotalCents: 6000, discountCents: 5000, commissionCents: 600 });
  });

  it("guarda B1: desconto que deixa o líquido abaixo da taxa fixa é detectado", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 1000, quantity: 1, discountPerUnitCents: 950 }], { ...rule, fixedCentsPerTicket: 100 });
    expect(lineWithNegativePayout(f, "ORGANIZER")).toMatchObject({ unitPriceCents: 50, discountPerUnitCents: 950 });
    expect(lineWithNegativePayout(f, "BUYER")).toBeUndefined();
  });

  it("recusa desconto negativo ou maior que o preço", () => {
    expect(() => computeFees([{ ticketTypeId: "a", unitPriceCents: 100, quantity: 1, discountPerUnitCents: 101 }], rule)).toThrow(RangeError);
    expect(() => computeFees([{ ticketTypeId: "a", unitPriceCents: 100, quantity: 1, discountPerUnitCents: -1 }], rule)).toThrow(RangeError);
  });
});

describe("undercutHalfPrice", () => {
  it("acusa inteira com desconto abaixo da meia mais barata", () => {
    expect(undercutHalfPrice(4000, [5000, 4500])).toBe(4500);
    expect(undercutHalfPrice(4500, [5000, 4500])).toBeUndefined();
  });

  it("sem meia paga ou cortesia (líquido 0) não acusa", () => {
    expect(undercutHalfPrice(100, [])).toBeUndefined();
    expect(undercutHalfPrice(100, [0])).toBeUndefined();
    expect(undercutHalfPrice(0, [5000])).toBeUndefined();
  });
});
