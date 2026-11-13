// Período dos relatórios de vendas: datas AAAA-MM-DD no horário de São Paulo
// (o mesmo dos gráficos do painel). O fim é inclusivo para quem lê ("até 30/11")
// e vira exclusivo no banco (00:00 do dia seguinte).
import { zonedLocalToUtc } from "@/lib/datetime";

export const REPORT_TIMEZONE = "America/Sao_Paulo";

export interface SalesPeriod {
  /** Início inclusivo (UTC) ou nulo = desde sempre. */
  from: Date | null;
  /** Fim exclusivo (UTC) ou nulo = até agora. */
  to: Date | null;
  /** Valores normalizados para os campos e links (AAAA-MM-DD ou ""). */
  de: string;
  ate: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayStart(day: string): Date | null {
  if (!DAY.test(day)) return null;
  try {
    return zonedLocalToUtc(`${day}T00:00`, REPORT_TIMEZONE);
  } catch {
    return null;
  }
}

/** Dia local (AAAA-MM-DD) de um instante. */
export function localDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIMEZONE }).format(d);
}

/** Datas inválidas são ignoradas; início depois do fim é trocado. */
export function parseSalesPeriod(input: { de?: string | null; ate?: string | null }): SalesPeriod {
  let de = input.de && dayStart(input.de) ? input.de : "";
  let ate = input.ate && dayStart(input.ate) ? input.ate : "";
  if (de && ate && de > ate) [de, ate] = [ate, de];
  const from = de ? dayStart(de) : null;
  const end = ate ? dayStart(ate) : null;
  return { from, to: end ? new Date(end.getTime() + 86_400_000) : null, de, ate };
}

/** Atalhos de período (últimos N dias incluem hoje). */
export function periodPresets(now = new Date()) {
  const today = localDay(now);
  const daysAgo = (n: number) => localDay(new Date(now.getTime() - n * 86_400_000));
  return [
    { label: "7 dias", de: daysAgo(6), ate: today },
    { label: "30 dias", de: daysAgo(29), ate: today },
    { label: "Este mês", de: today.slice(0, 8) + "01", ate: today },
    { label: "Tudo", de: "", ate: "" },
  ];
}
