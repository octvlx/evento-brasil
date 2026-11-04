// L7c — reserva da cota legal de meia-entrada: cálculo puro.
import { describe, expect, it } from "vitest";
import { HALF_PRICE_POLICY, limitPercentForForm, quotaOf } from "@/features/half-price/policy";
import {
  checkHalfPriceRequest,
  computeHalfPriceState,
  formatReleaseAt,
  halfPriceRequestMessage,
  stockChangeError,
  ticketAvailability,
  type HalfPriceEventInput,
  type HalfPriceTypeInput,
} from "@/features/half-price/quota";

const STARTS = new Date("2026-12-10T23:00:00.000Z"); // 20:00 em São Paulo
const H = 3_600_000;
const before48 = new Date(STARTS.getTime() - 100 * H);

function ev(over: Partial<HalfPriceEventInput> = {}): HalfPriceEventInput {
  return { capacity: 1000, startsAt: STARTS, halfPriceQuotaBps: null, halfPriceRegime: "FEDERAL", venueCapacity: null, ...over };
}
let seq = 0;
function tt(over: Partial<HalfPriceTypeInput> & { quantityTotal: number }): HalfPriceTypeInput {
  return { id: `t${++seq}`, kind: "GENERAL", priceCents: 10000, isHidden: false, quantityReserved: 0, quantitySold: 0, ...over };
}
const full = (n: number, over: Partial<HalfPriceTypeInput> = {}) => tt({ quantityTotal: n, ...over });
const half = (n: number, over: Partial<HalfPriceTypeInput> = {}) => tt({ quantityTotal: n, kind: "HALF_PRICE", priceCents: 5000, ...over });

describe("política", () => {
  it("40%, 48/72 h e floor", () => {
    expect(HALF_PRICE_POLICY).toMatchObject({ quotaBps: 4000, deadlineHours: 48, largeVenueDeadlineHours: 72, largeVenueThreshold: 10_000, rounding: "floor" });
    // Cenário 20: estoque < 10 e arredondamento.
    expect([1, 2, 3, 4, 5, 9, 10].map((n) => quotaOf(n, 4000))).toEqual([0, 0, 1, 1, 2, 3, 4]);
    expect(quotaOf(5, 4000, "ceil")).toBe(2);
    expect(quotaOf(3, 4000, "ceil")).toBe(2);
  });

  it("formulário: limite antigo abaixo de 40% aparece como 40%", () => {
    expect([null, 0, 3000, 4000, 5000].map(limitPercentForForm)).toEqual([null, 40, 40, 40, 50]);
  });
});

describe("prazo (cenários 1–4)", () => {
  const types = () => [full(60), half(40)];
  it("local de 1.000 → 48 h", () => {
    const s = computeHalfPriceState(ev({ venueCapacity: 1000 }), types(), before48);
    expect(s.deadlineHours).toBe(48);
    expect(s.releaseAt.toISOString()).toBe(new Date(STARTS.getTime() - 48 * H).toISOString());
    expect(s.physicalCapacity).toBe(1000);
  });
  it("10.000 exatos → 48 h; 15.000 → 72 h", () => {
    expect(computeHalfPriceState(ev({ venueCapacity: 10_000 }), types(), before48).deadlineHours).toBe(48);
    expect(computeHalfPriceState(ev({ venueCapacity: 15_000 }), types(), before48).deadlineHours).toBe(72);
  });
  it("sem local usa a capacidade do evento", () => {
    expect(computeHalfPriceState(ev({ capacity: 12_000 }), types(), before48)).toMatchObject({ deadlineHours: 72, physicalCapacity: null, eventCapacity: 12_000 });
    // O local manda quando existe, mesmo com evento maior.
    expect(computeHalfPriceState(ev({ capacity: 12_000, venueCapacity: 5000 }), types(), before48).deadlineHours).toBe(48);
  });
});

describe("estado", () => {
  it("cota, saldo, bloqueio e disponíveis", () => {
    const s = computeHalfPriceState(ev({ capacity: 100 }), [full(70, { quantitySold: 50 }), half(30, { quantitySold: 10, quantityReserved: 5 })], before48);
    expect(s).toMatchObject({
      eligibleStock: 100, quota: 40, halfLimit: Infinity, halfCommitted: 15, fullCommitted: 50,
      applicable: true, reserveActive: true, balance: 25, blocked: 25, status: "RESERVED",
      capacityLeft: 35, fullAvailable: 10, halfAvailable: 15, violation: 0,
    });
    expect(s.warnings).toEqual(["HALF_STOCK_BELOW_QUOTA"]);
  });

  it("cenário 5: inteira barrada quando só resta a cota; meia passa (6)", () => {
    const e = ev({ capacity: 10 });
    const f = full(10, { quantitySold: 6 });
    const h = half(10);
    const s = computeHalfPriceState(e, [f, h], before48);
    expect(s).toMatchObject({ quota: 4, fullAvailable: 0, halfAvailable: 4, blocked: 4 });
    expect(checkHalfPriceRequest(e, [f, h], [{ ticketTypeId: f.id, quantity: 1 }], before48)).toBe("RESERVED_FOR_HALF_PRICE");
    expect(checkHalfPriceRequest(e, [f, h], [{ ticketTypeId: h.id, quantity: 4 }], before48)).toBeNull();
    expect(ticketAvailability(s, [f, h]).get(f.id)).toEqual({ available: 0, reason: "RESERVED_FOR_HALF_PRICE" });
    expect(ticketAvailability(s, [f, h]).get(h.id)).toEqual({ available: 4, reason: null });
  });

  it("cenário 7: transição exata no releaseAt", () => {
    const e = ev({ capacity: 10 });
    const f = full(10, { quantitySold: 6 });
    const h = half(10);
    const releaseAt = new Date(STARTS.getTime() - 48 * H);
    expect(checkHalfPriceRequest(e, [f, h], [{ ticketTypeId: f.id, quantity: 1 }], new Date(releaseAt.getTime() - 1))).toBe("RESERVED_FOR_HALF_PRICE");
    expect(checkHalfPriceRequest(e, [f, h], [{ ticketTypeId: f.id, quantity: 4 }], releaseAt)).toBeNull();
    const s = computeHalfPriceState(e, [f, h], releaseAt);
    expect(s).toMatchObject({ status: "RELEASED", reserveActive: false, blocked: 0, fullAvailable: 4, balance: 4 });
  });

  it("cenário 8: vendas iniciadas dentro do prazo já valem como liberadas", () => {
    const now = new Date(STARTS.getTime() - 10 * H);
    expect(computeHalfPriceState(ev(), [full(60), half(40)], now)).toMatchObject({ status: "RELEASED", reserveActive: false, blocked: 0, fullAvailable: 100 });
  });

  it("cota esgotada: status EXHAUSTED; com limite 40% a meia acaba", () => {
    const s = computeHalfPriceState(ev({ capacity: 10, halfPriceQuotaBps: 4000 }), [full(10), half(10, { quantitySold: 4 })], before48);
    expect(s).toMatchObject({ status: "EXHAUSTED", balance: 0, blocked: 0, halfLimit: 4, halfAvailable: 0, halfUnavailableReason: "QUOTA_EXHAUSTED", fullAvailable: 6 });
  });

  it("cenário 17: múltiplos lotes de inteira e de meia somam", () => {
    const types = [full(20, { quantitySold: 20 }), full(30, { quantitySold: 10 }), half(10, { quantitySold: 10 }), half(40, { quantitySold: 2 })];
    const s = computeHalfPriceState(ev(), types, before48);
    expect(s).toMatchObject({ eligibleStock: 100, quota: 40, halfCommitted: 12, fullCommitted: 30, balance: 28, fullAvailable: 30, halfAvailable: 38 });
  });

  it("cenário 21: promocional/VIP elegível; cortesia e oculto pago não", () => {
    const types = [
      full(50),
      tt({ quantityTotal: 10, kind: "VIP", priceCents: 30000 }),
      tt({ quantityTotal: 10, kind: "PROMO", priceCents: 4000 }),
      half(30),
      tt({ quantityTotal: 20, kind: "FREE", priceCents: 0, quantitySold: 5 }),
      tt({ quantityTotal: 10, priceCents: 10000, isHidden: true, quantitySold: 3 }),
    ];
    const s = computeHalfPriceState(ev({ capacity: 1000 }), types, before48);
    expect(s).toMatchObject({ eligibleStock: 100, quota: 40, nonEligibleCommitted: 8 });
    // Meia oculta conta no uso, mas não torna o evento aplicável sozinha.
    expect(computeHalfPriceState(ev(), [full(10), half(5, { isHidden: true })], before48)).toMatchObject({ applicable: false, notApplicableReason: "NO_HALF_PRICE_TYPE" });
  });

  it("capacidade limita a base: E = capacidade − não elegíveis comprometidos", () => {
    const types = [full(100), half(100), tt({ quantityTotal: 50, kind: "FREE", priceCents: 0, quantitySold: 20 })];
    expect(computeHalfPriceState(ev({ capacity: 120 }), types, before48)).toMatchObject({ eligibleStock: 100, quota: 40 });
  });

  it("não elegível disponível segue a regra do pedido (gratuito reduz a base)", () => {
    const e = ev({ capacity: 100 });
    const f = full(100, { quantitySold: 60 });
    const h = half(40);
    const free = tt({ quantityTotal: 100, kind: "FREE", priceCents: 0 });
    const s = computeHalfPriceState(e, [f, h, free], before48);
    expect(s.nonEligibleAvailable).toBeGreaterThan(0);
    const k = s.nonEligibleAvailable;
    expect(checkHalfPriceRequest(e, [f, h, free], [{ ticketTypeId: free.id, quantity: k }], before48)).toBeNull();
    expect(checkHalfPriceRequest(e, [f, h, free], [{ ticketTypeId: free.id, quantity: k + 1 }], before48)).toBe("RESERVED_FOR_HALF_PRICE");
    expect(ticketAvailability(s, [f, h, free]).get(free.id)?.available).toBe(k);
  });

  it("cenário 20: estoque < 10", () => {
    for (const [n, q] of [[1, 0], [2, 0], [3, 1], [5, 2], [9, 3], [10, 4]] as const) {
      const f = full(n);
      const h = half(n);
      const s = computeHalfPriceState(ev({ capacity: n }), [f, h], before48);
      expect(s.quota).toBe(q);
      expect(s.fullAvailable).toBe(n - q);
      // A última inteira não protegida passa; a seguinte é barrada (se houver cota).
      expect(checkHalfPriceRequest(ev({ capacity: n }), [f, h], [{ ticketTypeId: f.id, quantity: n - q }], before48)).toBeNull();
      if (q > 0) expect(checkHalfPriceRequest(ev({ capacity: n }), [f, h], [{ ticketTypeId: f.id, quantity: n - q + 1 }], before48)).toBe("RESERVED_FOR_HALF_PRICE");
    }
    // Estoque 1 ou 2: cota 0 → EXHAUSTED sem bloqueio.
    expect(computeHalfPriceState(ev({ capacity: 2 }), [full(2), half(2)], before48)).toMatchObject({ status: "EXHAUSTED", blocked: 0 });
  });

  it("cenário 22: limite 50% permite meia além de 40%; < 40% vale 40%", () => {
    const f = full(10);
    const h = half(10, { quantitySold: 4 });
    const e50 = ev({ capacity: 10, halfPriceQuotaBps: 5000 });
    expect(computeHalfPriceState(e50, [f, h], before48)).toMatchObject({ quota: 4, halfLimit: 5, halfAvailable: 1 });
    expect(checkHalfPriceRequest(e50, [f, h], [{ ticketTypeId: h.id, quantity: 1 }], before48)).toBeNull();
    expect(checkHalfPriceRequest(e50, [f, h], [{ ticketTypeId: h.id, quantity: 2 }], before48)).toBe("HALF_QUOTA_EXHAUSTED");
    const e20 = ev({ capacity: 10, halfPriceQuotaBps: 2000 });
    const s20 = computeHalfPriceState(e20, [f, half(10)], before48);
    expect(s20).toMatchObject({ quota: 4, halfLimit: 4 });
    expect(s20.warnings).toContain("CONFIGURED_BPS_BELOW_LEGAL");
  });

  it("cenários 23–24: NOT_SUBJECT e sem meia → NOT_APPLICABLE, sem bloqueio", () => {
    const f = full(10, { quantitySold: 9 });
    const ns = computeHalfPriceState(ev({ capacity: 10, halfPriceRegime: "NOT_SUBJECT" }), [f, half(10)], before48);
    expect(ns).toMatchObject({ status: "NOT_APPLICABLE", notApplicableReason: "NOT_SUBJECT", blocked: 0, balance: 0, fullAvailable: 1 });
    const none = computeHalfPriceState(ev({ capacity: 10 }), [f], before48);
    expect(none).toMatchObject({ status: "NOT_APPLICABLE", notApplicableReason: "NO_HALF_PRICE_TYPE", fullAvailable: 1 });
    expect(computeHalfPriceState(ev({ capacity: 10 }), [tt({ quantityTotal: 10, kind: "FREE", priceCents: 0 }), half(0)], before48).notApplicableReason).toBe("NO_ELIGIBLE_STOCK");
  });

  it("violação: inteiras já dentro da cota (data adiada) barram só não-meia", () => {
    const e = ev({ capacity: 10 });
    const f = full(10, { quantitySold: 8 });
    const h = half(10);
    const s = computeHalfPriceState(e, [f, h], before48);
    expect(s.violation).toBe(2);
    expect(s.fullAvailable).toBe(0);
    expect(checkHalfPriceRequest(e, [f, h], [{ ticketTypeId: f.id, quantity: 1 }], before48)).toBe("RESERVED_FOR_HALF_PRICE");
    expect(checkHalfPriceRequest(e, [f, h], [{ ticketTypeId: h.id, quantity: 2 }], before48)).toBeNull();
  });

  it("pedido misto: meia no mesmo pedido não piora a reserva", () => {
    const e = ev({ capacity: 10 });
    const f = full(10, { quantitySold: 5 });
    const h = half(10);
    expect(checkHalfPriceRequest(e, [f, h], [{ ticketTypeId: f.id, quantity: 1 }, { ticketTypeId: h.id, quantity: 4 }], before48)).toBeNull();
    expect(checkHalfPriceRequest(e, [f, h], [{ ticketTypeId: f.id, quantity: 2 }, { ticketTypeId: h.id, quantity: 3 }], before48)).toBe("RESERVED_FOR_HALF_PRICE");
  });
});

describe("guarda de mudança de estoque", () => {
  it("cenário 18 (puro): redução que invade a cota é recusada; aumento ok", () => {
    const e = ev({ capacity: 100 });
    const h = half(40);
    const before = computeHalfPriceState(e, [full(60, { quantitySold: 60 }), h], before48);
    const reduced = computeHalfPriceState({ ...e, capacity: 90 }, [full(60, { quantitySold: 60 }), h], before48);
    expect(stockChangeError(before, reduced)).toMatch(/reserva legal de meia-entrada/);
    const increased = computeHalfPriceState({ ...e, capacity: 200 }, [full(160, { quantitySold: 60 }), h], before48);
    expect(stockChangeError(before, increased)).toBeNull();
  });
});

describe("mensagens", () => {
  it("formata no fuso do evento", () => {
    const releaseAt = new Date(STARTS.getTime() - 48 * H);
    expect(formatReleaseAt(releaseAt, "America/Sao_Paulo")).toBe("08/12/2026 às 20:00");
    expect(halfPriceRequestMessage("RESERVED_FOR_HALF_PRICE", releaseAt, "America/Manaus")).toBe(
      "Os ingressos restantes estão reservados para meia-entrada até 08/12/2026 às 19:00.",
    );
    expect(halfPriceRequestMessage("HALF_QUOTA_EXHAUSTED", releaseAt, "America/Sao_Paulo")).toBe("Cota de meia-entrada esgotada.");
  });
});
