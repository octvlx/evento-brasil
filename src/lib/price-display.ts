// Exibição do preço por ingresso como o comprador paga (Decreto 13.108/2026,
// preço total desde a oferta). Os valores vêm SEMPRE do servidor
// (`quoteUnitPrice` no catálogo); aqui só se formata.
import { formatBRL } from "./money";

/** Preço por ingresso: valor de face + taxa de serviço do comprador (0 se o organizador assume). */
export interface PriceQuote {
  priceCents: number;
  serviceFeeCents: number;
  totalCents: number;
}

/** "R$ 100,00 + R$ 10,00 de taxa" quando o comprador paga taxa; senão null. */
export function feeBreakdownText(q: PriceQuote): string | null {
  return q.serviceFeeCents > 0 ? `${formatBRL(q.priceCents)} + ${formatBRL(q.serviceFeeCents)} de taxa` : null;
}

/** Preço do card: total com a taxa discriminada, ou "Gratuito" / "Ingressos em breve". */
export function priceLabel(min: PriceQuote | null): { label: string; detail: string | null } {
  if (min === null) return { label: "Ingressos em breve", detail: null };
  if (min.totalCents === 0) return { label: "Gratuito", detail: null };
  const detail = feeBreakdownText(min);
  return { label: `A partir de ${formatBRL(min.totalCents)}`, detail: detail && `(${detail})` };
}
