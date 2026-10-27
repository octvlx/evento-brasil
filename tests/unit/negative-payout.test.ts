// Guarda B1 (ADR 0002): com bearer ORGANIZER, comissão por unidade maior que o
// preço deixaria o repasse do organizador negativo.
import { describe, expect, it } from "vitest";
import { computeFees, lineWithNegativePayout } from "@/features/fees/policy";

const rule = { policyVersion: "t:v1", percentBps: 700, fixedCentsPerTicket: 100, bearer: "ORGANIZER" as const };

describe("repasse negativo", () => {
  it("detecta ingresso de R$ 0,50 com taxa fixa de R$ 1 (bearer ORGANIZER)", () => {
    const f = computeFees(
      [
        { ticketTypeId: "caro", unitPriceCents: 10000, quantity: 1 },
        { ticketTypeId: "barato", unitPriceCents: 50, quantity: 2 },
      ],
      rule,
    );
    expect(f.organizerShareCents).toBeLessThan(10000);
    expect(lineWithNegativePayout(f, "ORGANIZER")).toMatchObject({ ticketTypeId: "barato", commissionPerUnitCents: 104 });
  });

  it("aceita comissão igual ao preço (repasse zero)", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 100, quantity: 1 }], { ...rule, percentBps: 0 });
    expect(f.organizerShareCents).toBe(0);
    expect(lineWithNegativePayout(f, "ORGANIZER")).toBeUndefined();
  });

  it("ingresso gratuito continua válido (comissão 0)", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 0, quantity: 3 }], rule);
    expect(lineWithNegativePayout(f, "ORGANIZER")).toBeUndefined();
  });

  it("bearer BUYER não é afetado: a taxa é cobrada à parte do comprador", () => {
    const buyerRule = { ...rule, bearer: "BUYER" as const };
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 50, quantity: 1 }], buyerRule);
    expect(f).toMatchObject({ totalCents: 154, commissionCents: 104, organizerShareCents: 50 });
    expect(lineWithNegativePayout(f, "BUYER")).toBeUndefined();
  });
});
