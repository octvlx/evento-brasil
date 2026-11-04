// Política legal da meia-entrada (L7c). Único lugar com os números da regra.
//
// - Cota: 40% dos ingressos elegíveis à venda ao público (Lei 12.933/2013;
//   Decreto 8.537/2015, art. 9º).
// - Prazo (art. 10): a reserva vale até 48 h antes do início; 72 h se a
//   capacidade do local passar de 10.000 (10.000 exatos = 48 h).
// - Arredondamento `floor` (provisório): nunca reserva mais que 40% e fração de
//   ingresso não existe. Trocar para `ceil` é só mudar aqui.
//
// Requer revisão jurídica antes de valer como parecer; os valores seguem a
// especificação da L7c.

export const HALF_PRICE_POLICY = {
  quotaBps: 4000,
  deadlineHours: 48,
  largeVenueDeadlineHours: 72,
  largeVenueThreshold: 10_000,
  rounding: "floor",
} as const satisfies {
  quotaBps: number;
  deadlineHours: number;
  largeVenueDeadlineHours: number;
  largeVenueThreshold: number;
  rounding: "floor" | "ceil";
};

/** Parte `bps` de `base` ingressos, com o arredondamento da política. */
export function quotaOf(base: number, bps: number, rounding: "floor" | "ceil" = HALF_PRICE_POLICY.rounding): number {
  const exact = (base * bps) / 10_000;
  return rounding === "ceil" ? Math.ceil(exact) : Math.floor(exact);
}

/**
 * Limite de meia em % para preencher o formulário (null = sem limite). Um limite antigo
 * abaixo do mínimo legal aparece como o mínimo, que é o que o cálculo já aplica; assim
 * o organizador não fica preso a um valor que o formulário agora recusa.
 */
export function limitPercentForForm(bps: number | null): number | null {
  return bps === null ? null : Math.max(bps, HALF_PRICE_POLICY.quotaBps) / 100;
}

/** Horas de antecedência da liberação, pela capacidade do local (ou do evento, sem local). */
export function deadlineHoursFor(capacity: number): number {
  return capacity > HALF_PRICE_POLICY.largeVenueThreshold ? HALF_PRICE_POLICY.largeVenueDeadlineHours : HALF_PRICE_POLICY.deadlineHours;
}
