// Política de taxas: cálculo puro e determinístico em centavos.
//
// - Comissão por unidade = round_half_up(preço × bps / 10000) + fixo.
// - Ingressos gratuitos (preço 0) nunca geram comissão.
// - Meia-entrada (decisão D4): a taxa é proporcional ao valor da meia. A parte
//   percentual já acompanha o preço; a parte fixa cai à metade, como o preço
//   (meia = 50% da inteira, Lei 12.933/2013).
// - Cupom (ADR 0002): "preço" acima é o preço LÍQUIDO (tabela − desconto);
//   um cupom de 100% gera ingresso gratuito, sem comissão.
// - bearer ORGANIZER: comprador paga o valor de face; comissão é descontada
//   do repasse do organizador.
// - bearer BUYER: comissão é cobrada do comprador como "taxa de serviço",
//   exibida de forma destacada antes do pagamento.
// - Custos do processador de pagamento são registrados à parte quando o
//   provedor os informa (processingFeeBearer).

import { applyBps } from "@/lib/money";

export type FeeBearer = "ORGANIZER" | "BUYER";

export interface FeeRule {
  policyVersion: string;
  percentBps: number;
  fixedCentsPerTicket: number;
  bearer: FeeBearer;
}

export interface FeeLineInput {
  ticketTypeId: string;
  /** Preço de tabela (do banco). */
  unitPriceCents: number;
  quantity: number;
  /** Desconto de cupom por unidade (ADR 0002), 0 ≤ desconto ≤ preço. */
  discountPerUnitCents?: number;
  /** Tipo HALF_PRICE: parte fixa da comissão proporcional (D4). */
  halfPrice?: boolean;
}

export interface FeeLine {
  ticketTypeId: string;
  quantity: number;
  listUnitPriceCents: number;
  discountPerUnitCents: number;
  /** Preço efetivamente cobrado = tabela − desconto. Comissão e taxa incidem sobre ele. */
  unitPriceCents: number;
  lineDiscountCents: number;
  commissionPerUnitCents: number;
  serviceFeePerUnitCents: number;
  lineSubtotalCents: number;
  lineCommissionCents: number;
  lineServiceFeeCents: number;
}

export interface FeeBreakdown {
  policyVersion: string;
  lines: FeeLine[];
  subtotalCents: number;
  /** Σ desconto × quantidade (o subtotal já é líquido). */
  discountCents: number;
  serviceFeeCents: number;
  totalCents: number;
  commissionCents: number;
  organizerShareCents: number;
}

/** Fração da parte fixa da comissão cobrada na meia-entrada (D4): a mesma do preço. */
export const HALF_PRICE_FIXED_FEE_BPS = 5_000;

export function commissionPerUnit(unitPriceCents: number, rule: Pick<FeeRule, "percentBps" | "fixedCentsPerTicket">, halfPrice = false): number {
  if (unitPriceCents === 0) return 0;
  const fixed = halfPrice ? applyBps(rule.fixedCentsPerTicket, HALF_PRICE_FIXED_FEE_BPS) : rule.fixedCentsPerTicket;
  return applyBps(unitPriceCents, rule.percentBps) + fixed;
}

/**
 * Com bearer ORGANIZER a comissão sai do repasse; se a comissão por unidade
 * passar do preço (taxa fixa maior que o ingresso), o repasse fica negativo e
 * o razão não fecha. Devolve a primeira linha nessa situação, se houver.
 * Preço 0 nunca entra (comissão 0); bearer BUYER nunca entra (comissão é paga
 * à parte pelo comprador).
 */
export function lineWithNegativePayout(breakdown: Pick<FeeBreakdown, "lines">, bearer: FeeBearer): FeeLine | undefined {
  if (bearer !== "ORGANIZER") return undefined;
  return breakdown.lines.find((l) => l.commissionPerUnitCents > l.unitPriceCents);
}

export function computeFees(lines: FeeLineInput[], rule: FeeRule): FeeBreakdown {
  const out: FeeLine[] = lines.map((l) => {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new RangeError("Quantidade inválida");
    if (!Number.isSafeInteger(l.unitPriceCents) || l.unitPriceCents < 0) throw new RangeError("Preço inválido");
    const discount = l.discountPerUnitCents ?? 0;
    if (!Number.isSafeInteger(discount) || discount < 0 || discount > l.unitPriceCents) throw new RangeError("Desconto inválido");
    const net = l.unitPriceCents - discount;
    const commission = commissionPerUnit(net, rule, l.halfPrice);
    const serviceFee = rule.bearer === "BUYER" ? commission : 0;
    return {
      ticketTypeId: l.ticketTypeId,
      quantity: l.quantity,
      listUnitPriceCents: l.unitPriceCents,
      discountPerUnitCents: discount,
      unitPriceCents: net,
      lineDiscountCents: discount * l.quantity,
      commissionPerUnitCents: commission,
      serviceFeePerUnitCents: serviceFee,
      lineSubtotalCents: net * l.quantity,
      lineCommissionCents: commission * l.quantity,
      lineServiceFeeCents: serviceFee * l.quantity,
    };
  });
  const subtotalCents = out.reduce((s, l) => s + l.lineSubtotalCents, 0);
  const discountCents = out.reduce((s, l) => s + l.lineDiscountCents, 0);
  const serviceFeeCents = out.reduce((s, l) => s + l.lineServiceFeeCents, 0);
  const commissionCents = out.reduce((s, l) => s + l.lineCommissionCents, 0);
  const totalCents = subtotalCents + serviceFeeCents;
  return {
    policyVersion: rule.policyVersion,
    lines: out,
    subtotalCents,
    discountCents,
    serviceFeeCents,
    totalCents,
    commissionCents,
    // O organizador recebe o total pago menos a comissão da plataforma
    // (antes de custos de processamento).
    organizerShareCents: totalCents - commissionCents,
  };
}
