import { describe, expect, it } from "vitest";
import { applyBps, formatBRL, parseBRLToCents } from "@/lib/money";
import { commissionPerUnit, computeFees } from "@/features/fees/policy";

const rule = { policyVersion: "t:v1", percentBps: 700, fixedCentsPerTicket: 0, bearer: "ORGANIZER" as const };

describe("money", () => {
  it("formata BRL", () => {
    expect(formatBRL(10000).replace(/\s/g, " ")).toBe("R$ 100,00");
    expect(formatBRL(123456).replace(/\s/g, " ")).toBe("R$ 1.234,56");
  });
  it("converte texto em centavos", () => {
    expect(parseBRLToCents("1.234,56")).toBe(123456);
    expect(parseBRLToCents("R$ 10")).toBe(1000);
    expect(parseBRLToCents("10,5")).toBe(1050);
    expect(parseBRLToCents("abc")).toBeNull();
    expect(parseBRLToCents("1,234")).toBeNull();
  });
  it("arredonda half-up de forma determinística", () => {
    expect(applyBps(10000, 700)).toBe(700);
    expect(applyBps(1050, 700)).toBe(74); // 73,5 → 74
    expect(applyBps(1049, 700)).toBe(73); // 73,43 → 73
    expect(() => applyBps(1.5, 700)).toThrow();
    expect(() => applyBps(100, 10_001)).toThrow();
  });
});

describe("política de taxas", () => {
  it("R$100 → comissão R$7, organizador R$93 (comissão do organizador)", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 10000, quantity: 1 }], rule);
    expect(f).toMatchObject({ subtotalCents: 10000, serviceFeeCents: 0, totalCents: 10000, commissionCents: 700, organizerShareCents: 9300 });
  });
  it("comissão do comprador vira taxa de serviço destacada", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 10000, quantity: 2 }], { ...rule, bearer: "BUYER" });
    expect(f).toMatchObject({ subtotalCents: 20000, serviceFeeCents: 1400, totalCents: 21400, commissionCents: 1400, organizerShareCents: 20000 });
  });
  it("meia-entrada (D4): parte fixa proporcional, metade da inteira", () => {
    const rule = { percentBps: 700, fixedCentsPerTicket: 200 };
    expect(commissionPerUnit(10000, rule)).toBe(900);
    expect(commissionPerUnit(5000, rule, true)).toBe(450);
    expect(commissionPerUnit(5000, { percentBps: 0, fixedCentsPerTicket: 99 }, true)).toBe(50); // half-up
    expect(commissionPerUnit(0, rule, true)).toBe(0);
    const fees = computeFees(
      [
        { ticketTypeId: "inteira", unitPriceCents: 10000, quantity: 1 },
        { ticketTypeId: "meia", unitPriceCents: 5000, quantity: 2, halfPrice: true },
      ],
      { policyVersion: "t", bearer: "BUYER", ...rule },
    );
    expect(fees.lines.map((l) => l.serviceFeePerUnitCents)).toEqual([900, 450]);
    expect(fees.serviceFeeCents).toBe(900 + 2 * 450);
  });

  it("ingresso gratuito não gera comissão, mesmo com taxa fixa", () => {
    expect(commissionPerUnit(0, { percentBps: 700, fixedCentsPerTicket: 200 })).toBe(0);
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 0, quantity: 3 }], { ...rule, fixedCentsPerTicket: 200 });
    expect(f.totalCents).toBe(0);
    expect(f.commissionCents).toBe(0);
  });
  it("comissão é calculada por unidade (independe do agrupamento)", () => {
    const a = computeFees([{ ticketTypeId: "a", unitPriceCents: 1050, quantity: 3 }], rule);
    expect(a.commissionCents).toBe(74 * 3);
  });
  it("rejeita quantidade/preço inválidos", () => {
    expect(() => computeFees([{ ticketTypeId: "a", unitPriceCents: 100, quantity: 0 }], rule)).toThrow();
    expect(() => computeFees([{ ticketTypeId: "a", unitPriceCents: -1, quantity: 1 }], rule)).toThrow();
  });
});
