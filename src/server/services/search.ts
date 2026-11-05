// Busca pública inteligente: interpretação da frase ("Rock em São Paulo") e
// sugestões agrupadas por tipo. Cidades só da tabela City com evento público
// (nunca a base inteira do IBGE, nunca o IBGE em runtime); nada é criado aqui.
import "server-only";
import { cache } from "react";
import { cityLabel, cityMatchesPrefix, interpretSearch, matchCategory, normalizeSearchText, sanitizeSearch, splitPartialLocation, type SearchInterpretation } from "@/lib/search-query";
import type { Db } from "../db";
import { listCategories, listCities } from "./catalog";
import { citiesWithMatchingEvents, publicVenuesMatching, rankPublicEvents } from "./search-ranking";
import { suggestExternalEvents } from "./external-events";

type PublicCity = Awaited<ReturnType<typeof listCities>>[number];

export interface SearchPlan extends SearchInterpretation<PublicCity> {
  category: { id: string; name: string; slug: string } | null;
}

/**
 * O que a página de resultados vai buscar. `citySlug` (cidade escolhida numa
 * sugestão) vence a cidade escrita; slug desconhecido é ignorado.
 */
export const planSearch = cache(async (db: Db, rawQuery: unknown, citySlug?: string): Promise<SearchPlan> => {
  const [cities, categories] = await Promise.all([listCities(db), listCategories(db)]);
  const explicit = citySlug ? (cities.find((c) => c.slug === citySlug) ?? null) : null;
  const interp = interpretSearch(rawQuery, cities, explicit);
  const category = interp.text ? matchCategory(interp.text, categories) : null;
  return { ...interp, category: category && { id: category.id, name: category.name, slug: category.slug } };
});

export type Suggestion =
  | { kind: "combo"; label: string; q: string; citySlug: string }
  | { kind: "city"; label: string; q: string; citySlug: string }
  | { kind: "event"; label: string; detail: string; q: string }
  | { kind: "venue"; label: string; detail: string; q: string }
  | { kind: "category"; label: string; q: string };

export interface SuggestionGroup {
  kind: Suggestion["kind"];
  title: string;
  items: Suggestion[];
}

const MAX_PER_GROUP = 4;

/**
 * Sugestões enquanto o usuário digita. Combinações ("Rock em São Paulo — SP") só
 * aparecem para cidades que têm evento público correspondente ao termo.
 */
export async function suggestSearch(db: Db, rawInput: unknown, now = new Date()): Promise<SuggestionGroup[]> {
  const raw = sanitizeSearch(rawInput);
  if (raw.length < 2) return [];
  const [cities, categories] = await Promise.all([listCities(db, { now }), listCategories(db)]);
  const groups: SuggestionGroup[] = [];
  const byPrefix = (partial: string) =>
    cities
      .map((c) => [cityMatchesPrefix(c, partial), c] as const)
      .filter(([rank]) => rank >= 0)
      .sort((a, b) => a[0] - b[0] || Number(b[1].isFeatured) - Number(a[1].isFeatured) || a[1].name.localeCompare(b[1].name, "pt-BR"));

  // "Rock em São" → termo + início de cidade.
  const partial = splitPartialLocation(raw);
  if (partial?.text) {
    const withEvents = await citiesWithMatchingEvents(db, partial.text, { now });
    // Eventos externos publicados também valem para a combinação "termo em cidade".
    for (const e of await suggestExternalEvents(db, partial.text, { take: 50 }, now)) if (e.cityId) withEvents.add(e.cityId);
    const combos = byPrefix(partial.partialCity)
      .filter(([, c]) => withEvents.has(c.id))
      .slice(0, MAX_PER_GROUP)
      .map(([, c]): Suggestion => ({ kind: "combo", label: `${partial.text} em ${cityLabel(c)}`, q: `${partial.text} em ${c.name}`, citySlug: c.slug }));
    if (combos.length) groups.push({ kind: "combo", title: "Buscas sugeridas", items: combos });
  }

  const interp = interpretSearch(raw, cities);
  const text = interp.city ? interp.text : raw;
  const cityItems = partial
    ? []
    : byPrefix(raw)
        .slice(0, MAX_PER_GROUP)
        .map(([, c]): Suggestion => ({ kind: "city", label: cityLabel(c), q: cityLabel(c), citySlug: c.slug }));
  if (cityItems.length) groups.push({ kind: "city", title: "Cidades", items: cityItems });

  if (text) {
    const category = matchCategory(text, categories);
    const ranked = (await rankPublicEvents(db, text, { citySlug: interp.city?.slug, categoryId: category?.id, now, limit: MAX_PER_GROUP })).map((r) => r.id);
    if (ranked.length) {
      const rows = await db.event.findMany({
        where: { id: { in: ranked } },
        select: { id: true, title: true, city: { select: { name: true, state: true } }, venue: { select: { name: true, city: { select: { name: true, state: true } } } } },
      });
      const order = new Map(ranked.map((id, i) => [id, i]));
      const items = rows
        .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
        .map((e): Suggestion => {
          const city = e.venue?.city ?? e.city;
          return { kind: "event", label: e.title, detail: [e.venue?.name, city && cityLabel(city)].filter(Boolean).join(" · ") || "Online", q: e.title };
        });
      groups.push({ kind: "event", title: "Eventos", items });
    }
    // Eventos externos publicados: entram depois dos vendidos aqui, marcados como externos.
    const room = MAX_PER_GROUP - (groups.find((g) => g.kind === "event")?.items.length ?? 0);
    if (room > 0) {
      const external = await suggestExternalEvents(db, text, { cityId: interp.city?.id, take: room }, now);
      const items = external.map((e): Suggestion => ({
        kind: "event",
        label: e.title,
        detail: ["Evento externo", e.venueName, e.cityName && cityLabel({ name: e.cityName, state: e.state ?? "" })].filter(Boolean).join(" · "),
        q: e.title,
      }));
      if (items.length) {
        const group = groups.find((g) => g.kind === "event");
        if (group) group.items.push(...items);
        else groups.push({ kind: "event", title: "Eventos", items });
      }
    }
    const venues = await publicVenuesMatching(db, text, MAX_PER_GROUP, now);
    if (venues.length) groups.push({ kind: "venue", title: "Locais", items: venues.map((v): Suggestion => ({ kind: "venue", label: v.name, detail: cityLabel({ name: v.city, state: v.state }), q: v.name })) });
    const cat = categories.filter((c) => matchCategory(text, [c]) || normalizeSearchText(c.name).startsWith(normalizeSearchText(text))).slice(0, 2);
    if (cat.length) groups.push({ kind: "category", title: "Categorias", items: cat.map((c): Suggestion => ({ kind: "category", label: c.name, q: c.name })) });
  }
  return groups;
}
