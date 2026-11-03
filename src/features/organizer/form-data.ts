import "server-only";
import type { Db } from "@/server/db";

/**
 * Listas de apoio do formulário de evento (categorias e locais da organização).
 * A cidade de um novo local vem do autocomplete do IBGE, não da tabela City.
 */
export async function eventFormOptions(db: Db, organizationId: string) {
  const [categories, venues] = await Promise.all([
    db.eventCategory.findMany({ orderBy: { sortOrder: "asc" } }),
    db.venue.findMany({ where: { OR: [{ organizationId }, { organizationId: null }] }, include: { city: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    venues: venues.map((v) => ({ id: v.id, label: `${v.name} (${v.city.name} – ${v.city.state})` })),
  };
}
