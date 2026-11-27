import { describe, expect, it } from "vitest";
import { commissionPreview } from "@/features/admin/commission-preview";

describe("prévia da comissão (admin)", () => {
  it("organizador paga o percentual: o fixo é cobrado do comprador e só o percentual sai do repasse", () => {
    const [full, half] = commissionPreview({ percent: 7, fixedCents: 200, bearer: "ORGANIZER", priceCents: 10_000 })!;
    expect(full).toMatchObject({ priceCents: 10_000, commissionCents: 900, buyerPaysCents: 10_200, organizerGetsCents: 9_300, negativePayout: false });
    // Meia: metade do preço e metade da parte fixa (D4).
    expect(half).toMatchObject({ priceCents: 5_000, commissionCents: 450, buyerPaysCents: 5_100, organizerGetsCents: 4_650 });
  });

  it("comprador paga: a comissão vira taxa de serviço e o organizador recebe o preço cheio", () => {
    const [full] = commissionPreview({ percent: 10, fixedCents: 0, bearer: "BUYER", priceCents: 5_000 })!;
    expect(full).toMatchObject({ commissionCents: 500, buyerPaysCents: 5_500, organizerGetsCents: 5_000 });
  });

  it("fixo acima do preço com o organizador pagando o percentual não deixa o repasse negativo", () => {
    const [full] = commissionPreview({ percent: 0, fixedCents: 500, bearer: "ORGANIZER", priceCents: 300 })!;
    expect(full).toMatchObject({ buyerPaysCents: 800, organizerGetsCents: 300, negativePayout: false });
  });

  it("valores inválidos não geram prévia", () => {
    expect(commissionPreview({ percent: 101, fixedCents: 0, bearer: "BUYER", priceCents: 100 })).toBeNull();
    expect(commissionPreview({ percent: 5, fixedCents: -1, bearer: "BUYER", priceCents: 100 })).toBeNull();
    expect(commissionPreview({ percent: 5, fixedCents: 0, bearer: "BUYER", priceCents: 0 })).toBeNull();
    expect(commissionPreview({ percent: Number.NaN, fixedCents: 0, bearer: "BUYER", priceCents: 100 })).toBeNull();
  });
});
