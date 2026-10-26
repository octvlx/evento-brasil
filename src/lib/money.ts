// Valores monetários sempre em centavos inteiros (BRL).

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatBRL(cents: number): string {
  assertCents(cents);
  return brl.format(cents / 100);
}

export function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Valor monetário inválido: ${cents}`);
}

/** "1.234,56" | "1234,5" | "R$ 10" → centavos. Retorna null se inválido. */
export function parseBRLToCents(input: string): number | null {
  const s = input.replace(/\s|R\$/g, "");
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(s)) return null;
  const [intPart, frac = ""] = s.replace(/\./g, "").split(",");
  const cents = Number(intPart) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Centavos → "1234,56" para inputs de formulário. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/**
 * Aplica pontos-base (1 bp = 0,01%) com arredondamento half-up determinístico.
 * Só aceita valores não negativos — evita ambiguidade de arredondamento.
 */
export function applyBps(cents: number, bps: number): number {
  assertCents(cents);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError(`bps inválido: ${bps}`);
  if (cents < 0) throw new RangeError("applyBps requer valor não negativo");
  return Math.floor((cents * bps + 5_000) / 10_000);
}
