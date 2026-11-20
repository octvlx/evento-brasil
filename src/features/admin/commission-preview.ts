// Prévia da comissão no formulário de regras do admin: o que o comprador paga e o que
// o organizador recebe por ingresso, com a MESMA conta do pedido (computeFees). O custo
// de processamento do provedor não entra (depende do meio de pagamento).
import { computeFees, type FeeBearer } from "@/features/fees/policy";

export interface CommissionPreviewRow {
  label: string;
  priceCents: number;
  commissionCents: number;
  buyerPaysCents: number;
  organizerGetsCents: number;
  /** Comissão maior que o preço com o organizador pagando: o ingresso não poderia ser vendido. */
  negativePayout: boolean;
}

/** `percent` em % (ex.: 7,5) e `fixedCents` por ingresso; inválido → null (o formulário mostra o erro). */
export function commissionPreview(input: { percent: number; fixedCents: number; bearer: FeeBearer; priceCents: number }): CommissionPreviewRow[] | null {
  const { percent, fixedCents, bearer, priceCents } = input;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  if (!Number.isSafeInteger(fixedCents) || fixedCents < 0) return null;
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) return null;
  const rule = { policyVersion: "preview", percentBps: Math.round(percent * 100), fixedCentsPerTicket: fixedCents, bearer };
  const row = (label: string, unitPriceCents: number, halfPrice: boolean): CommissionPreviewRow => {
    const f = computeFees([{ ticketTypeId: label, unitPriceCents, quantity: 1, halfPrice }], rule);
    return {
      label,
      priceCents: unitPriceCents,
      commissionCents: f.commissionCents,
      buyerPaysCents: f.totalCents,
      organizerGetsCents: f.organizerShareCents,
      negativePayout: f.organizerShareCents < 0,
    };
  };
  // Meia-entrada: metade do preço (arredondada para cima) e parte fixa proporcional (D4).
  return [row("Inteira", priceCents, false), row("Meia-entrada", Math.ceil(priceCents / 2), true)];
}
