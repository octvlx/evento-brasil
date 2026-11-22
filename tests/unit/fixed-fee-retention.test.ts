import { describe, expect, it } from "vitest";
import { computeFees, fixedFeePerUnit } from "@/features/fees/policy";
import { splitPlatformDebitCents } from "@/server/services/ledger";
import { ARREPENDIMENTO_DAYS, retainedFixedFeeCents } from "@/server/services/refunds";

const rule = { policyVersion: "t", percentBps: 1000, fixedCentsPerTicket: 300, bearer: "BUYER" as const };

describe("parte fixa por unidade", () => {
  it("inteira, meia (metade) e gratuito/cupom de 100% (zero)", () => {
    const { lines } = computeFees(
      [
        { ticketTypeId: "a", unitPriceCents: 10_000, quantity: 1 },
        { ticketTypeId: "b", unitPriceCents: 5_000, quantity: 1, halfPrice: true },
        { ticketTypeId: "c", unitPriceCents: 0, quantity: 1 },
        { ticketTypeId: "d", unitPriceCents: 4_000, quantity: 1, discountPerUnitCents: 4_000 },
      ],
      rule,
    );
    expect(lines.map((l) => [l.fixedFeePerUnitCents, l.commissionPerUnitCents])).toEqual([
      [300, 1300],
      [150, 650],
      [0, 0],
      [0, 0],
    ]);
    expect(fixedFeePerUnit(1, rule)).toBe(300);
  });
});

describe("retainedFixedFeeCents", () => {
  const paidAt = new Date("2026-11-01T12:00:00Z");
  const after = (days: number) => new Date(paidAt.getTime() + days * 86_400_000 + 1);
  const base = { reason: "CUSTOMER_REQUEST" as const, order: { fixedFeeRefundable: false, paidAt }, fixedFeeCents: 600, coveredCents: 22_600, now: after(8) };

  it("retém o fixo no pedido do comprador após o arrependimento (qualquer provedor)", () => {
    expect(retainedFixedFeeCents(base)).toBe(600);
  });
  it.each([
    ["dentro do arrependimento", { now: after(ARREPENDIMENTO_DAYS - 1) }],
    ["exatamente no 7º dia", { now: new Date(paidAt.getTime() + ARREPENDIMENTO_DAYS * 86_400_000) }],
    ["fixo reembolsável", { order: { ...base.order, fixedFeeRefundable: true } }],
    ["alteração do evento", { reason: "EVENT_CHANGED" as const }],
    ["cancelamento do evento", { reason: "EVENT_CANCELLED" as const }],
    ["reembolso do admin", { reason: "ADMIN" as const }],
    ["sem data de pagamento", { order: { ...base.order, paidAt: null } }],
    ["fixo zerado", { fixedFeeCents: 0 }],
    ["fixo igual ao coberto (nunca zera o reembolso)", { fixedFeeCents: 300, coveredCents: 300 }],
  ])("não retém: %s", (_name, override) => {
    expect(retainedFixedFeeCents({ ...base, ...override })).toBe(0);
  });
});

describe("splitPlatformDebitCents (estorno com split do Mercado Pago)", () => {
  it("tira da plataforma a comissão proporcional ao valor estornado", () => {
    // R$ 226 com R$ 26 de comissão; estorno de R$ 220 (R$ 6 de fixo retido).
    expect(splitPlatformDebitCents(22_000, { amountCents: 22_600, feeCents: 2_600 })).toBe(2_531);
    expect(splitPlatformDebitCents(22_600, { amountCents: 22_600, feeCents: 2_600 })).toBe(2_600);
    expect(splitPlatformDebitCents(0, { amountCents: 22_600, feeCents: 2_600 })).toBe(0);
    expect(splitPlatformDebitCents(100, { amountCents: 0, feeCents: 0 })).toBe(0);
  });
});
