import { describe, expect, it } from "vitest";
import { commissionReturnedOnRefund } from "@/server/services/commission";

describe("comissão no reembolso", () => {
  it("pagamento real (split do Mercado Pago): a comissão sempre volta, qualquer que seja a regra", () => {
    expect(commissionReturnedOnRefund({ refundCommissionOnRefund: false }, false)).toBe(true);
    expect(commissionReturnedOnRefund({ refundCommissionOnRefund: true }, false)).toBe(true);
    expect(commissionReturnedOnRefund(null, false)).toBe(true);
  });

  it("provedor simulado: segue a regra; sem regra, devolve", () => {
    expect(commissionReturnedOnRefund({ refundCommissionOnRefund: false }, true)).toBe(false);
    expect(commissionReturnedOnRefund({ refundCommissionOnRefund: true }, true)).toBe(true);
    expect(commissionReturnedOnRefund(undefined, true)).toBe(true);
  });
});
