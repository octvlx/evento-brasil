import type { Prisma } from "@/generated/prisma/client";
import { zonedDateKey, zonedLocalToUtc } from "@/lib/datetime";

// Regra única de visibilidade pública de eventos externos, usada pelo catálogo (cidades),
// pela busca (sugestões e resultados), pelos destaques e pelas páginas. Fica num módulo
// leve para o catálogo não depender do serviço de importação.

/** Publicado, visto na última coleta (não ausente, não cancelado), não terminado e de fonte autorizada. */
export const publicExternalWhere = (now = new Date()): Prisma.ExternalEventWhereInput => ({
  review: "PUBLISHED",
  sourceStatus: "ACTIVE",
  // Sem horário: vale até o fim do dia local (margem de 24 h a partir da meia-noite).
  startsAt: { gt: new Date(now.getTime() - 24 * 3600_000) },
  source: { status: { not: "NEEDS_AUTHORIZATION" } },
});

/**
 * Início de "hoje" para eventos externos: meia-noite em Brasília menos 1 h, para incluir
 * os eventos de hoje de todos os fusos do Brasil (o mais adiantado, Noronha, é UTC−2).
 * Evento sem horário fica gravado à meia-noite local do dia: some no dia seguinte.
 */
export function externalTodayStart(now = new Date()): Date {
  return new Date(zonedLocalToUtc(`${zonedDateKey(now, "America/Sao_Paulo")}T00:00`, "America/Sao_Paulo").getTime() - 3600_000);
}

/** O dia do evento (no fuso dele) é anterior a hoje: já aconteceu. */
export function externalEventIsPast(e: { startsAt: Date; timezone: string }, now = new Date()): boolean {
  return zonedDateKey(e.startsAt, e.timezone) < zonedDateKey(now, e.timezone);
}
