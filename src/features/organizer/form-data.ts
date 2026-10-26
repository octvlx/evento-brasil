import "server-only";
import type { Db } from "@/server/db";

/** Listas de apoio do formulário de evento (categorias, cidades e locais da organização). */
export async function eventFormOptions(db: Db, organizationId: string) {
  const [categories, cities, venues] = await Promise.all([
    db.eventCategory.findMany({ orderBy: { sortOrder: "asc" } }),
    db.city.findMany({ orderBy: [{ state: "asc" }, { name: "asc" }] }),
    db.venue.findMany({ where: { OR: [{ organizationId }, { organizationId: null }] }, include: { city: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    cities: cities.map((c) => ({ id: c.id, label: `${c.name} – ${c.state}` })),
    venues: venues.map((v) => ({ id: v.id, label: `${v.name} (${v.city.name} – ${v.city.state})` })),
  };
}
