// Guarda B1 (ADR 0002): a parte da comissão descontada do repasse (o percentual, com
// bearer ORGANIZER) maior que o preço deixaria o repasse do organizador negativo.
// O valor fixo por ingresso é sempre pago pelo comprador, então não entra nessa conta.
import { describe, expect, it } from "vitest";
import { computeFees, lineWithNegativePayout } from "@/features/fees/policy";

const rule = { policyVersion: "t:v1", percentBps: 700, fixedCentsPerTicket: 100, bearer: "ORGANIZER" as const };

describe("repasse negativo", () => {
  it("ingresso de R$ 0,50 com taxa fixa de R$ 1 (bearer ORGANIZER): o fixo vai para o comprador e o repasse fica positivo", () => {
    const f = computeFees(
      [
        { ticketTypeId: "caro", unitPriceCents: 10000, quantity: 1 },
        { ticketTypeId: "barato", unitPriceCents: 50, quantity: 2 },
      ],
      rule,
    );
    // Comprador: 100,00 + 1,00 e 2 × (0,50 + 1,00). Repasse: preço − 7%.
    expect(f).toMatchObject({ totalCents: 10_400, serviceFeeCents: 300, commissionCents: 1_008, organizerShareCents: 9_392 });
    expect(lineWithNegativePayout(f)).toBeUndefined();
  });

  it("percentual acima de 100% é recusado no cálculo (o repasse nunca fica negativo)", () => {
    expect(() => computeFees([{ ticketTypeId: "a", unitPriceCents: 10_000, quantity: 1 }], { ...rule, percentBps: 10_001 })).toThrow(RangeError);
  });

  it("aceita percentual de 100% (repasse zero)", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 100, quantity: 1 }], { ...rule, percentBps: 10_000, fixedCentsPerTicket: 0 });
    expect(f.organizerShareCents).toBe(0);
    expect(lineWithNegativePayout(f)).toBeUndefined();
  });

  it("ingresso gratuito continua válido (comissão 0)", () => {
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 0, quantity: 3 }], rule);
    expect(lineWithNegativePayout(f)).toBeUndefined();
  });

  it("bearer BUYER: percentual e fixo cobrados à parte do comprador", () => {
    const buyerRule = { ...rule, bearer: "BUYER" as const };
    const f = computeFees([{ ticketTypeId: "a", unitPriceCents: 50, quantity: 1 }], buyerRule);
    expect(f).toMatchObject({ totalCents: 154, commissionCents: 104, organizerShareCents: 50 });
    expect(lineWithNegativePayout(f)).toBeUndefined();
  });
});
