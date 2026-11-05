import type { Prisma } from "@/generated/prisma/client";

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
