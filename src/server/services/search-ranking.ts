// Busca textual dos eventos públicos com relevância, no PostgreSQL. Sem extensão
// (unaccent/pg_trgm) nem migração: acentos saem com translate() e tudo o que não
// é letra/número vira espaço, igual a `normalizeSearchText` no TypeScript.
// Consultas sempre parametrizadas ($queryRaw com template do Prisma).
import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { normalizeSearchText, searchTokens } from "@/lib/search-query";
import type { Db } from "../db";

const ACCENTED = "áàâãäåéèêëíìîïóòôõöúùûüçñýÿ";
const PLAIN = "aaaaaaeeeeiiiiooooouuuucnyy";

/** Expressão SQL normalizada, com espaço nas pontas (casamento por palavra inteira). */
const norm = (sql: Prisma.Sql) => Prisma.sql`(' ' || regexp_replace(translate(lower(coalesce(${sql}, '')), ${ACCENTED}, ${PLAIN}), '[^a-z0-9]+', ' ', 'g') || ' ')`;

// Mesmas regras de `publicEventWhere` (catalog.ts): publicado, não encerrado e de
// organização aprovada. Quem usa os ids ainda aplica `publicEventWhere` no Prisma.
const PUBLIC = (now: Date) => Prisma.sql`e.status = 'PUBLISHED' AND e."endsAt" > ${now} AND o.status = 'APPROVED'`;

const like = (s: string) => `%${s}%`;

export interface RankOptions {
  citySlug?: string | null;
  /** Categoria reconhecida com confiança ("teatro"): conta como correspondência. */
  categoryId?: string | null;
  now?: Date;
  limit?: number;
}

/**
 * Eventos públicos que correspondem ao texto, do mais relevante ao menos:
 * título igual (100) › título começando (70) › palavra do título (55) › trecho do
 * título (45) › categoria reconhecida (35) › local (30) › organizador (20) ›
 * resumo/descrição (15), +5 por palavra no título. Correspondência = todas as
 * palavras relevantes em algum campo (título, resumo, descrição, local, cidade,
 * categoria, organizador) ou a categoria reconhecida. Com `citySlug`, só a cidade.
 */
export async function rankPublicEvents(db: Db, text: string, opts: RankOptions = {}): Promise<{ id: string; score: number }[]> {
  const tokens = searchTokens(text);
  const phrase = normalizeSearchText(text);
  if (!tokens.length && !opts.categoryId) return [];
  const now = opts.now ?? new Date();
  const city = opts.citySlug ? Prisma.sql`AND (c.slug = ${opts.citySlug} OR vc.slug = ${opts.citySlug})` : Prisma.empty;
  const category = opts.categoryId ?? "";
  const all = tokens.length ? Prisma.join(tokens.map((t) => Prisma.sql`doc LIKE ${like(` ${t}`)}`), " AND ") : Prisma.sql`FALSE`;
  const perToken = tokens.length ? Prisma.join(tokens.map((t) => Prisma.sql`(CASE WHEN t LIKE ${like(` ${t}`)} THEN 5 ELSE 0 END)`), " + ") : Prisma.sql`0`;
  const p = ` ${phrase} `;
  return db.$queryRaw<{ id: string; score: number }[]>`
    WITH docs AS (
      SELECT e.id, e."startsAt", e."categoryId",
             ${norm(Prisma.sql`e.title`)} AS t,
             ${norm(Prisma.sql`v.name`)} AS v,
             ${norm(Prisma.sql`o.name`)} AS org,
             ${norm(Prisma.sql`coalesce(e.summary, '') || ' ' || e.description`)} AS d,
             ${norm(Prisma.sql`concat_ws(' ', e.title, e.summary, e.description, v.name, c.name, vc.name, k.name, o.name)`)} AS doc
        FROM "Event" e
        JOIN "Organization" o ON o.id = e."organizationId"
        JOIN "EventCategory" k ON k.id = e."categoryId"
        LEFT JOIN "Venue" v ON v.id = e."venueId"
        LEFT JOIN "City" c ON c.id = e."cityId"
        LEFT JOIN "City" vc ON vc.id = v."cityId"
       WHERE ${PUBLIC(now)} ${city}
    )
    SELECT id, score::int AS score FROM (
      SELECT id, "startsAt", "categoryId", (${all}) AS matched,
             (CASE WHEN t = ${p} THEN 100 WHEN t LIKE ${`${p}%`} THEN 70 WHEN t LIKE ${like(p)} THEN 55 WHEN ${phrase.length >= 3} AND t LIKE ${like(phrase)} THEN 45 ELSE 0 END)
           + (CASE WHEN "categoryId" = ${category} THEN 35 ELSE 0 END)
           + (CASE WHEN ${phrase.length >= 3} AND v LIKE ${like(phrase)} THEN 30 ELSE 0 END)
           + (CASE WHEN ${phrase.length >= 3} AND org LIKE ${like(phrase)} THEN 20 ELSE 0 END)
           + (CASE WHEN ${phrase.length >= 3} AND d LIKE ${like(phrase)} THEN 15 ELSE 0 END)
           + ${perToken} AS score
        FROM docs
    ) ranked
    WHERE matched OR "categoryId" = ${category}
    ORDER BY score DESC, "startsAt" ASC, id ASC
    LIMIT ${opts.limit ?? 500}`;
}

/** Cidades (id) com evento público que corresponde ao texto: sugestões "Rock em São Paulo". */
export async function citiesWithMatchingEvents(db: Db, text: string, opts: Omit<RankOptions, "citySlug" | "limit"> = {}): Promise<Set<string>> {
  const ids = (await rankPublicEvents(db, text, opts)).map((r) => r.id);
  if (!ids.length) return new Set();
  const rows = await db.event.findMany({ where: { id: { in: ids } }, select: { cityId: true, venue: { select: { cityId: true } } } });
  return new Set(rows.flatMap((r) => [r.cityId, r.venue?.cityId].filter((x): x is string => !!x)));
}

/** Locais com evento público cujo nome contém o texto (palavra começando com ele). */
export async function publicVenuesMatching(db: Db, text: string, limit = 4, now = new Date()) {
  const phrase = normalizeSearchText(text);
  if (phrase.length < 2) return [];
  return db.$queryRaw<{ id: string; name: string; city: string; state: string }[]>`
    SELECT v.id, v.name, c.name AS city, c.state
      FROM "Venue" v JOIN "City" c ON c.id = v."cityId"
     WHERE ${norm(Prisma.sql`v.name`)} LIKE ${like(` ${phrase}`)}
       AND EXISTS (SELECT 1 FROM "Event" e JOIN "Organization" o ON o.id = e."organizationId" WHERE e."venueId" = v.id AND ${PUBLIC(now)})
     ORDER BY v.name ASC
     LIMIT ${limit}`;
}
