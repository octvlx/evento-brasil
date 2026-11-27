// Política de taxas: cálculo puro e determinístico em centavos.
//
// - Comissão por unidade = round_half_up(preço × bps / 10000) + fixo.
// - Ingressos gratuitos (preço 0) nunca geram comissão.
// - Meia-entrada (decisão D4, revista em 2026-11-27): a parte percentual
//   acompanha o preço da meia; o valor fixo por ingresso é cobrado inteiro.
// - Cupom (ADR 0002): "preço" acima é o preço LÍQUIDO (tabela − desconto);
//   um cupom de 100% gera ingresso gratuito, sem comissão.
// - Valor fixo por ingresso: SEMPRE pago pelo comprador, como "taxa de
//   serviço" destacada antes do pagamento (reembolsável ou não, conforme a regra).
// - `bearer` decide só quem paga a parte PERCENTUAL:
//   - ORGANIZER: descontada do repasse do organizador;
//   - BUYER: somada à taxa de serviço do comprador.
// - Custos do processador de pagamento são registrados à parte quando o
//   provedor os informa (processingFeeBearer).

import { applyBps, formatBRL } from "@/lib/money";

export type FeeBearer = "ORGANIZER" | "BUYER";

export interface FeeRule {
  policyVersion: string;
  percentBps: number;
  fixedCentsPerTicket: number;
  /** Quem paga a parte percentual. O valor fixo é sempre do comprador. */
  bearer: FeeBearer;
}

export interface FeeLineInput {
  ticketTypeId: string;
  /** Preço de tabela (do banco). */
  unitPriceCents: number;
  quantity: number;
  /** Desconto de cupom por unidade (ADR 0002), 0 ≤ desconto ≤ preço. */
  discountPerUnitCents?: number;
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
  /** Parte fixa contida em `commissionPerUnitCents` (meia: proporcional; gratuito: 0). */
  fixedFeePerUnitCents: number;
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

/** Regra em texto curto ("5% + R$ 2,50 por ingresso"), igual na home e em /publique-seu-evento. */
export function commissionHeadline(rule: Pick<FeeRule, "percentBps" | "fixedCentsPerTicket">): string {
  const percent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(rule.percentBps / 100);
  return rule.fixedCentsPerTicket > 0 ? `${percent}% + ${formatBRL(rule.fixedCentsPerTicket)} por ingresso` : `${percent}% por ingresso`;
}

/** Parte fixa da comissão por unidade: 0 em ingresso gratuito; inteira nos demais, meia-entrada inclusive (D4). */
export function fixedFeePerUnit(unitPriceCents: number, rule: Pick<FeeRule, "fixedCentsPerTicket">): number {
  return unitPriceCents === 0 ? 0 : rule.fixedCentsPerTicket;
}

export function commissionPerUnit(unitPriceCents: number, rule: Pick<FeeRule, "percentBps" | "fixedCentsPerTicket">): number {
  if (unitPriceCents === 0) return 0;
  return applyBps(unitPriceCents, rule.percentBps) + fixedFeePerUnit(unitPriceCents, rule);
}

/** Parte da comissão por unidade descontada do repasse: o percentual, só com bearer ORGANIZER. */
export function organizerFeePerUnit(unitPriceCents: number, rule: Pick<FeeRule, "percentBps" | "bearer">): number {
  return rule.bearer === "ORGANIZER" ? applyBps(unitPriceCents, rule.percentBps) : 0;
}

/**
 * Se a parte da comissão descontada do repasse passar do preço, o repasse fica
 * negativo e o razão não fecha. Devolve a primeira linha nessa situação, se houver.
 * Como só o percentual sai do repasse (o fixo é do comprador) e `applyBps` recusa
 * mais de 100%, hoje isso não acontece; fica como trava do razão.
 */
export function lineWithNegativePayout(breakdown: Pick<FeeBreakdown, "lines">): FeeLine | undefined {
  return breakdown.lines.find((l) => l.commissionPerUnitCents - l.serviceFeePerUnitCents > l.unitPriceCents);
}

export function computeFees(lines: FeeLineInput[], rule: FeeRule): FeeBreakdown {
  const out: FeeLine[] = lines.map((l) => {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new RangeError("Quantidade inválida");
    if (!Number.isSafeInteger(l.unitPriceCents) || l.unitPriceCents < 0) throw new RangeError("Preço inválido");
    const discount = l.discountPerUnitCents ?? 0;
    if (!Number.isSafeInteger(discount) || discount < 0 || discount > l.unitPriceCents) throw new RangeError("Desconto inválido");
    const net = l.unitPriceCents - discount;
    const commission = commissionPerUnit(net, rule);
    // O comprador paga sempre o fixo; o percentual também, se bearer BUYER.
    const serviceFee = commission - organizerFeePerUnit(net, rule);
    return {
      ticketTypeId: l.ticketTypeId,
      quantity: l.quantity,
      listUnitPriceCents: l.unitPriceCents,
      discountPerUnitCents: discount,
      unitPriceCents: net,
      lineDiscountCents: discount * l.quantity,
      commissionPerUnitCents: commission,
      fixedFeePerUnitCents: fixedFeePerUnit(net, rule),
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
