import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { ordersPagination } from "@/features/orders/pagination";
import type { Db } from "../db";

/** Eventos já encerrados por página em "Meus ingressos" (os próximos aparecem todos). */
export const PAST_PAGE_SIZE = 10;

/**
 * Ingressos do titular para "Meus ingressos". Próximos (evento não terminou): todos, do
 * mais próximo ao mais distante. Anteriores: por evento, do mais recente ao mais antigo,
 * em páginas de PAST_PAGE_SIZE eventos (`rawPage` = `?anteriores=N`), para o histórico
 * não carregar todos os ingressos de uma vez. Só ingressos de que o usuário é o titular.
 */
export async function loadMyTickets(db: Db, holderUserId: string, rawPage: string | string[] | undefined, now = new Date()) {
  const load = (where: Prisma.IssuedTicketWhereInput, orderBy: Prisma.IssuedTicketOrderByWithRelationInput[]) =>
    db.issuedTicket.findMany({
      where: { ...where, holderUserId },
      include: {
        ticketType: { select: { name: true } },
        order: { select: { status: true } },
        event: { select: { id: true, title: true, slug: true, startsAt: true, endsAt: true, timezone: true, coverImageUrl: true, status: true, transferDeadlineHours: true, transferMaxTransfers: true, transferAllowReturn: true } },
      },
      orderBy,
    });
  const pastWhere: Prisma.EventWhereInput = { endsAt: { lt: now }, tickets: { some: { holderUserId } } };
  const [upcoming, pastTotal] = await Promise.all([
    load({ event: { endsAt: { gte: now } } }, [{ event: { startsAt: "asc" } }, { issuedAt: "asc" }]),
    db.event.count({ where: pastWhere }),
  ]);
  const pastPage = ordersPagination(rawPage, pastTotal, PAST_PAGE_SIZE);
  const pastIds = pastTotal
    ? (await db.event.findMany({ where: pastWhere, select: { id: true }, orderBy: [{ startsAt: "desc" }, { id: "desc" }], skip: pastPage.skip, take: pastPage.take })).map((e) => e.id)
    : [];
  const pastTickets = pastIds.length ? await load({ eventId: { in: pastIds } }, [{ issuedAt: "asc" }]) : [];
  // Mesma ordem de pastIds (mais recente primeiro); cada evento com os seus ingressos.
  const pastByEvent = new Map(pastIds.map((id) => [id, [] as typeof pastTickets]));
  for (const t of pastTickets) pastByEvent.get(t.eventId)?.push(t);
  return { upcoming, past: [...pastByEvent.values()].filter((g) => g.length), pastTotal, pastPage };
}
