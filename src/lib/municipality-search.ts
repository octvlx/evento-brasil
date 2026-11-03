// Busca de municípios sem diferenciar acentos e maiúsculas. Sem dados: usada no
// servidor (src/lib/municipalities.ts) e no autocomplete, sobre a lista de uma UF.

export interface MunicipalityOption {
  id: number;
  nome: string;
}

/** "São João d'Aliança" → "sao joao d alianca". */
export function normalizeMunicipalityName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Ordem: nome igual, começo do nome, começo de uma palavra, trecho do nome; em
 * cada grupo, ordem alfabética (a lista de entrada já vem ordenada por nome).
 */
export function filterMunicipalities<T extends MunicipalityOption>(list: readonly T[], query: string, limit = 20): T[] {
  const q = normalizeMunicipalityName(query);
  if (!q) return list.slice(0, limit);
  const ranked: [number, T][] = [];
  for (const m of list) {
    const n = normalizeMunicipalityName(m.nome);
    const rank = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(` ${q}`) ? 2 : n.includes(q) ? 3 : -1;
    if (rank >= 0) ranked.push([rank, m]);
  }
  return ranked
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map(([, m]) => m);
}

export function compareMunicipalityNames(a: string, b: string) {
  return a.localeCompare(b, "pt-BR", { sensitivity: "base" });
}
