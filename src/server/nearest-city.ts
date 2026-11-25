// Cidade com eventos mais próxima de um ponto (latitude/longitude do navegador).
// Usa o centro e o retângulo de cada município (src/data/ibge-centroides.json,
// `npm run ibge:centroides`); nada de serviço externo: a localização não sai do site.
import "server-only";
import data from "@/data/ibge-centroides.json";
import { findMunicipality, findMunicipalityByName } from "@/lib/municipalities";

export type Point = { lat: number; lng: number };
type Area = Point & { south: number; west: number; north: number; east: number };

const AREAS = new Map(
  (data as [number, number, number, number, number, number, number][]).map(([id, lat, lng, south, west, north, east]) => [id, { lat, lng, south, west, north, east }]),
);

/** Acima disso, "perto de você" não faz sentido: a pessoa provavelmente está fora das cidades atendidas. */
export const NEARBY_MAX_KM = 300;

/** Distância em km pela fórmula de haversine (Terra esférica, raio médio). */
export function distanceKm(a: Point, b: Point) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

type CityLike = { name: string; state: string; ibgeCode: string | null };

/** Centro e retângulo do município da cidade: pelo código IBGE ou, em cidades antigas sem código, por nome + UF. */
export function cityArea(city: CityLike): Area | null {
  const m = findMunicipality(city.ibgeCode) ?? findMunicipalityByName(city.name, city.state);
  return m ? (AREAS.get(m.id) ?? null) : null;
}

const contains = (a: Area, p: Point) => p.lat >= a.south && p.lat <= a.north && p.lng >= a.west && p.lng <= a.east;

/**
 * A cidade mais próxima do ponto, até `maxKm`. Null se nenhuma estiver perto.
 * Cidade cujo retângulo contém o ponto vem primeiro, com `km` 0 (a pessoa está nela, ou
 * na divisa); entre várias, a de centro mais próximo. Senão, a de centro mais próximo.
 */
export function nearestCity<C extends CityLike>(cities: readonly C[], from: Point, maxKm = NEARBY_MAX_KM): { city: C; km: number } | null {
  let inside: { city: C; d: number } | null = null;
  let best: { city: C; km: number } | null = null;
  for (const city of cities) {
    const area = cityArea(city);
    if (!area) continue;
    const km = distanceKm(from, area);
    if (contains(area, from) && (!inside || km < inside.d)) inside = { city, d: km };
    if (km <= maxKm && (!best || km < best.km)) best = { city, km };
  }
  return inside ? { city: inside.city, km: 0 } : best;
}
