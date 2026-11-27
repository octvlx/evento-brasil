import { describe, expect, it } from "vitest";
import { commissionParts, simulatePayout } from "@/features/fees/payout-simulator";
import { computeFees } from "@/features/fees/policy";

const org = { percentBps: 1000, fixedCentsPerTicket: 200, bearer: "ORGANIZER" as const };
const buyer = { ...org, bearer: "BUYER" as const };

describe("simulador de repasse", () => {
  it("percentual do organizador: comprador paga o preço + o fixo, organizador recebe o preço menos o percentual", () => {
    expect(simulatePayout(5000, 100, org)).toEqual({
      buyerPaysPerTicket: 5200, serviceFeePerTicket: 200, commissionPerTicket: 700, percentPartPerTicket: 500, fixedPartPerTicket: 200, organizerPerTicket: 4500,
      buyersTotal: 520000, commissionTotal: 70000, organizerTotal: 450000, negativePayout: false,
    });
  });

  it("taxa do comprador: comprador paga preço + taxa, organizador recebe o preço cheio", () => {
    expect(simulatePayout(5000, 2, buyer)).toMatchObject({ buyerPaysPerTicket: 5700, commissionPerTicket: 700, organizerPerTicket: 5000, buyersTotal: 11400, organizerTotal: 10000 });
  });

  it("bate com o cálculo do checkout, inclusive na meia-entrada", () => {
    const sim = simulatePayout(2500, 3, org)!;
    const fees = computeFees([{ ticketTypeId: "x", unitPriceCents: 2500, quantity: 3 }], { ...org, policyVersion: "v" });
    expect(sim.commissionTotal).toBe(fees.commissionCents);
    expect(sim.organizerTotal).toBe(fees.organizerShareCents);
    expect(sim.commissionPerTicket).toBe(450); // 10% de 25,00 + fixo inteiro
  });

  it("gratuito sem comissão; fixo maior que o preço não zera o repasse; entrada inválida é recusada", () => {
    expect(simulatePayout(0, 10, org)).toMatchObject({ commissionTotal: 0, organizerTotal: 0, negativePayout: false });
    expect(simulatePayout(100, 1, org)).toMatchObject({ buyerPaysPerTicket: 300, organizerPerTicket: 90, negativePayout: false });
    for (const [p, q] of [[-1, 1], [5000, 0], [5000, 1.5], [10_000_001, 1], [5000, 100_001]]) expect(simulatePayout(p, q, org)).toBeNull();
  });

  it("separa a comissão em percentual e valor fixo (meia: fixo inteiro; gratuito: nada)", () => {
    expect(simulatePayout(5000, 1, org)).toMatchObject({ percentPartPerTicket: 500, fixedPartPerTicket: 200 });
    expect(simulatePayout(2500, 1, org)).toMatchObject({ percentPartPerTicket: 250, fixedPartPerTicket: 200 });
    expect(simulatePayout(0, 1, org)).toMatchObject({ percentPartPerTicket: 0, fixedPartPerTicket: 0 });
    const nbsp = (t: string) => t.replace(/ /g, " ");
    expect(nbsp(commissionParts(1000, 500, 200))).toBe("10% (R$ 5,00) + R$ 2,00 fixo");
    expect(nbsp(commissionParts(750, 375, 0))).toBe("7,5% (R$ 3,75)");
  });
});
