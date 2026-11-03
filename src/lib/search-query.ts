// Interpretação da busca pública em uma frase ("Rock em São Paulo", "Teatro em
// Curitiba", "Shows no Rio de Janeiro"). Determinística e sem dados próprios: as
// cidades vêm de quem chama (só cidades com evento público, da tabela City).
// Usada no servidor (/eventos e sugestões) e no navegador (rótulos).
import { normalizeMunicipalityName as normalize } from "@/lib/municipality-search";

export { normalize as normalizeSearchText };

/** Tamanho máximo aceito para a busca (o resto é descartado). */
export const SEARCH_MAX_LENGTH = 80;

export interface SearchCity {
  id: string;
  slug: string;
  name: string;
  state: string;
}

export interface SearchInterpretation<C extends SearchCity = SearchCity> {
  /** Texto digitado, aparado e limitado. */
  raw: string;
  /** O que sobra para a busca textual depois de tirar a localização reconhecida. */
  text: string;
  /** Cidade reconhecida com confiança (filtro geográfico). */
  city: C | null;
  /** Homônimos sem UF ("Bom Jesus"): nenhum filtro é aplicado; o usuário escolhe. */
  candidates: C[];
  /** "perto de"/"próximo de": sem dados geográficos, vale a própria cidade. */
  near: boolean;
}

// Conectores do fim da frase, do mais longo para o mais curto (normalizados).
const CONNECTORS = [
  "na cidade de",
  "no municipio de",
  "em torno de",
  "proximo de",
  "proximo a",
  "proximo ao",
  "proximo da",
  "proximo do",
  "perto de",
  "perto do",
  "perto da",
  "em",
  "no",
  "na",
  "nos",
  "nas",
];
const NEAR = new Set(["proximo de", "proximo a", "proximo ao", "proximo da", "proximo do", "perto de", "perto do", "perto da", "em torno de"]);

export function sanitizeSearch(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX_LENGTH) : "";
}

/** Cidades cujo nome (ou "nome UF") é exatamente o trecho normalizado. */
function citiesNamed<C extends SearchCity>(tail: string, cities: readonly C[]): { matches: C[]; withUf: boolean } {
  const exact = cities.filter((c) => normalize(c.name) === tail);
  if (exact.length) return { matches: exact, withUf: false };
  // "São Paulo SP", "São Paulo - SP", "São Paulo/SP", "São Paulo — SP".
  const m = /^(.*) ([a-z]{2})$/.exec(tail);
  if (!m) return { matches: [], withUf: false };
  return { matches: cities.filter((c) => normalize(c.name) === m[1] && c.state.toLowerCase() === m[2]), withUf: true };
}

/**
 * Separa termo e localização. Só reconhece cidade:
 * - depois de um conector ("rock em são paulo", "shows no rio de janeiro"); ou
 * - quando a frase inteira é a cidade ("São Paulo", "Bom Jesus RS").
 * Palavra solta no meio da frase não vira cidade (evita "Natal" em "show de natal").
 * Com `explicit` (cidade escolhida numa sugestão), ela vence e a localização
 * escrita é retirada do texto.
 */
export function interpretSearch<C extends SearchCity>(rawInput: unknown, cities: readonly C[], explicit?: C | null): SearchInterpretation<C> {
  const raw = sanitizeSearch(rawInput);
  const tokens = normalize(raw).split(" ").filter(Boolean);
  const base = { raw, text: raw, city: explicit ?? null, candidates: [] as C[], near: false };
  if (!tokens.length) return base;

  const whole = citiesNamed(tokens.join(" "), cities);
  if (whole.matches.length) return resolve(base, whole.matches, "", false, explicit);

  // Conector mais à direita cujo resto da frase é uma cidade conhecida.
  for (let i = tokens.length - 1; i >= 1; i--) {
    for (const connector of CONNECTORS) {
      const words = connector.split(" ");
      if (i - words.length + 1 < 1) continue;
      const start = i - words.length + 1;
      if (tokens.slice(start, i + 1).join(" ") !== connector) continue;
      const tail = tokens.slice(i + 1).join(" ");
      if (!tail) continue;
      const found = citiesNamed(tail, cities);
      if (!found.matches.length) continue;
      const text = stripTrailingLocation(raw, start);
      return resolve(base, found.matches, text, NEAR.has(connector), explicit);
    }
  }
  return base;
}

function resolve<C extends SearchCity>(base: SearchInterpretation<C>, matches: C[], text: string, near: boolean, explicit?: C | null): SearchInterpretation<C> {
  if (explicit) return { ...base, text, city: explicit, near };
  if (matches.length === 1) return { ...base, text, city: matches[0], near };
  // Homônimos sem UF: preserva o texto original e não filtra em silêncio.
  return { ...base, candidates: matches, near };
}

/** Texto original (com acentos) até antes do conector na posição `tokenIndex`. */
function stripTrailingLocation(raw: string, tokenIndex: number): string {
  const parts = raw.split(/\s+/);
  // Tokens normalizados podem ser mais numerosos (hífen, apóstrofo): conta pelas palavras originais.
  let seen = 0;
  for (let i = 0; i < parts.length; i++) {
    const n = normalize(parts[i]).split(" ").filter(Boolean).length;
    if (seen + n > tokenIndex) return parts.slice(0, i).join(" ").replace(/[\s,–—-]+$/, "").trim();
    seen += n;
  }
  return raw;
}

/** "Rock em São", "Teatro no Rio": termo + início de cidade, para sugestões combinadas. */
export function splitPartialLocation(rawInput: unknown): { text: string; partialCity: string; connector: string } | null {
  const raw = sanitizeSearch(rawInput);
  const tokens = normalize(raw).split(" ").filter(Boolean);
  for (let i = tokens.length - 2; i >= 1; i--) {
    for (const connector of CONNECTORS) {
      const words = connector.split(" ");
      const start = i - words.length + 1;
      if (start < 1 || tokens.slice(start, i + 1).join(" ") !== connector) continue;
      const partialCity = tokens.slice(i + 1).join(" ");
      if (partialCity.length < 2) continue;
      return { text: stripTrailingLocation(raw, start), partialCity, connector };
    }
  }
  return null;
}

/** O nome da cidade começa com (ou tem uma palavra começando com) o trecho. */
export function cityMatchesPrefix(city: SearchCity, partial: string): number {
  const n = normalize(city.name);
  const p = normalize(partial);
  if (!p) return -1;
  if (n === p || `${n} ${city.state.toLowerCase()}` === p) return 0;
  if (n.startsWith(p)) return 1;
  if (n.includes(` ${p}`)) return 2;
  return -1;
}

export const cityLabel = (c: { name: string; state: string }) => `${c.name} — ${c.state}`;

// Palavras que não ajudam a achar evento ("festival de música" → festival, musica).
const STOPWORDS = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "no", "na", "nos", "nas", "um", "uma", "para", "com", "por", "ao", "à", "evento", "eventos"]);

/** Palavras relevantes do texto, normalizadas, sem repetição (no máximo 8). */
export function searchTokens(text: string): string[] {
  return [...new Set(normalize(text).split(" ").filter((t) => t && !STOPWORDS.has(t)))].slice(0, 8);
}

/** Forma singular aproximada ("festivais" → "festival", "shows" → "show"). */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ais")) return `${word.slice(0, -3)}al`;
  if (word.length > 4 && word.endsWith("eis")) return `${word.slice(0, -3)}el`;
  if (word.length > 4 && word.endsWith("oes")) return `${word.slice(0, -3)}ao`;
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/**
 * Categoria só com correspondência confiável: TODAS as palavras da busca são
 * palavras do nome da categoria ("teatro" → "Teatro e espetáculos", "shows" →
 * "Shows e música"). "Rock" não corresponde a nada e continua como termo.
 */
export function matchCategory<T extends { name: string; slug: string }>(text: string, categories: readonly T[]): T | null {
  const words = searchTokens(text).map(stem);
  if (!words.length || words.length > 3) return null;
  const hits = categories.filter((c) => {
    const vocab = new Set([...searchTokens(c.name), ...searchTokens(c.slug.replace(/-/g, " "))].map(stem));
    return words.every((w) => vocab.has(w));
  });
  return hits.length === 1 ? hits[0] : null;
}
