// Texto próprio das páginas categoria × cidade (/cidades/<cidade>/<categoria>): uma frase
// por categoria e um resumo montado com os números reais da página. Sem texto genérico
// repetido: cada página fala da sua cidade, dos seus locais e das suas datas.
import { formatBRL } from "./money";

/** Frase de abertura por categoria (slug do seed). Categoria nova cai no texto genérico. */
const LEADS: Record<string, (city: string) => string> = {
  "shows-e-musica": (c) => `Shows e música ao vivo em ${c}: de apresentações intimistas a grandes palcos.`,
  festas: (c) => `Festas em ${c} para curtir a noite, das pistas eletrônicas ao samba.`,
  teatro: (c) => `Teatro e espetáculos em ${c}: peças, musicais, dança e circo.`,
  "stand-up": (c) => `Stand-up em ${c}: noites de humor com comediantes da cena local e nacional.`,
  festivais: (c) => `Festivais em ${c}, com vários artistas e atrações no mesmo evento.`,
  gastronomia: (c) => `Eventos de gastronomia em ${c}: festivais, degustações e experiências.`,
  esportes: (c) => `Eventos esportivos em ${c}: corridas, partidas e competições.`,
  "cursos-e-workshops": (c) => `Cursos e workshops em ${c} para aprender algo novo, presencialmente.`,
  infantil: (c) => `Programação infantil em ${c}: peças, oficinas e atividades para a família.`,
  congressos: (c) => `Congressos e palestras em ${c}, para atualização profissional e networking.`,
};

export function categoryLead(categorySlug: string, categoryName: string, cityName: string) {
  return LEADS[categorySlug]?.(cityName) ?? `${categoryName} em ${cityName}: veja a programação e compre ingressos.`;
}

type Stats = { firstStartsAt: Date | null; lastStartsAt: Date | null; minPriceCents: number | null; hasFree: boolean; venues: string[] };

const monthYear = (d: Date, timeZone: string) => new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone }).format(d);
const list = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`);

/** Resumo com os números da página: quantidade, período, locais e preço. */
export function categorySummary(o: { total: number; categoryName: string; cityName: string; timezone: string; stats: Stats }) {
  const { total, stats, timezone } = o;
  if (!total) return `No momento não há eventos de ${o.categoryName.toLowerCase()} à venda em ${o.cityName}. Veja abaixo outras categorias na cidade e a mesma categoria em outras cidades.`;
  const parts = [total === 1 ? `Há 1 evento à venda` : `Há ${total} eventos à venda`];
  if (stats.firstStartsAt && stats.lastStartsAt) {
    const a = monthYear(stats.firstStartsAt, timezone);
    const b = monthYear(stats.lastStartsAt, timezone);
    parts[0] += a === b ? `, em ${a}` : `, de ${a} a ${b}`;
  }
  parts[0] += ".";
  if (stats.venues.length) parts.push(`${stats.venues.length === 1 ? "Local" : "Locais"}: ${list(stats.venues)}.`);
  if (stats.hasFree && stats.minPriceCents === 0) parts.push("Tem evento gratuito.");
  else if (stats.minPriceCents != null) parts.push(`Ingressos a partir de ${formatBRL(stats.minPriceCents)}.`);
  return parts.join(" ");
}
