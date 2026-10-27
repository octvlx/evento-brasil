// Desconto de cupom (ADR 0002, D1/D2): cálculo puro, por unidade, em centavos.
//
// - PERCENT: desconto = applyBps(preço, bps) (meia-para-cima: o meio centavo
//   favorece o comprador).
// - FIXED_PER_TICKET: desconto = min(valor, preço).
// - Nunca deixa preço negativo; ingresso gratuito não recebe desconto.
// O desconto sai da receita do organizador; comissão e taxa de serviço incidem
// sobre o preço líquido (computeFees).

import { applyBps } from "@/lib/money";

export type DiscountType = "PERCENT" | "FIXED_PER_TICKET";

export interface DiscountSpec {
  discountType: DiscountType;
  percentBps: number | null;
  amountCents: number | null;
}

export function discountPerUnit(unitPriceCents: number, coupon: DiscountSpec): number {
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) throw new RangeError("Preço inválido");
  if (unitPriceCents === 0) return 0;
  if (coupon.discountType === "PERCENT") {
    if (coupon.percentBps === null) throw new RangeError("Cupom percentual sem percentBps");
    return Math.min(applyBps(unitPriceCents, coupon.percentBps), unitPriceCents);
  }
  if (coupon.amountCents === null || !Number.isSafeInteger(coupon.amountCents) || coupon.amountCents <= 0)
    throw new RangeError("Cupom de valor fixo sem amountCents");
  return Math.min(coupon.amountCents, unitPriceCents);
}

/**
 * Meia-entrada (pendência jurídica, ADR 0002 D3): um cupom não pode deixar uma
 * inteira mais barata que a meia-entrada mais barata do evento. Devolve o
 * menor preço de meia que seria "furado" pelo preço líquido, se houver.
 * Cortesia (cupom de 100%, preço líquido 0) não é preço de venda e fica de fora.
 */
export function undercutHalfPrice(netUnitPriceCents: number, halfPricesCents: number[]): number | undefined {
  if (netUnitPriceCents === 0) return undefined;
  const paidHalf = halfPricesCents.filter((p) => p > 0);
  if (!paidHalf.length) return undefined;
  const cheapest = Math.min(...paidHalf);
  return netUnitPriceCents < cheapest ? cheapest : undefined;
}
