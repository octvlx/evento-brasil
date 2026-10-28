// Links de divulgação rastreados (ADR 0002, passo 3): cadastro pelo organizador.
//
// O redirecionamento público `/r/[code]` (conta o clique e grava o cookie de
// atribuição) é de paginas-publicas; copiar a atribuição para o pedido é do
// fluxo de pedidos. Os UTMs de um link não mudam depois de criado: o link já
// pode ter sido divulgado, e mudar mentiria nos relatórios. Para outra
// campanha, cria-se outro link.
import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { trackingLinkInputSchema, type TrackingLinkInput } from "@/features/schemas";
import type { Db } from "../db";
import { audit } from "../audit";
import { assertEventPermission, assertOrgPermission, type Actor } from "../auth/permissions";
import { randomCode } from "../crypto";
import { AppError, invalidState, notFound } from "../errors";

export const TRACKING_LINK_CODE_LENGTH = 8;

export async function listEventTrackingLinks(db: Db, actor: Actor, eventId: string) {
  await assertEventPermission(db, actor, eventId, "event:write");
  const links = await db.trackingLink.findMany({
    where: { eventId },
    include: { coupon: { select: { code: true } }, _count: { select: { orders: { where: { status: "PAID" } } } } },
    orderBy: { createdAt: "desc" },
  });
  return links.map((l) => ({
    id: l.id,
    code: l.code,
    name: l.name,
    utmSource: l.utmSource,
    utmMedium: l.utmMedium,
    utmCampaign: l.utmCampaign,
    utmContent: l.utmContent,
    utmTerm: l.utmTerm,
    couponCode: l.coupon?.code ?? null,
    clicks: l.clicks,
    paidOrders: l._count.orders,
    archived: l.archivedAt !== null,
  }));
}

export async function createTrackingLink(db: Db, actor: Actor, eventId: string, raw: TrackingLinkInput) {
  const { organizationId } = await assertEventPermission(db, actor, eventId, "event:write");
  const input = trackingLinkInputSchema.parse(raw);
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { status: true } });
  if (event.status !== "DRAFT" && event.status !== "PENDING_REVIEW" && event.status !== "PUBLISHED") {
    throw invalidState("Este evento não aceita mais links de divulgação.");
  }
  const couponId = input.couponId || null;
  if (couponId) {
    // FK simples (por causa do SetNull): a organização e o evento são checados aqui.
    const coupon = await db.coupon.findFirst({ where: { id: couponId, organizationId, OR: [{ eventId }, { eventId: null }] } });
    if (!coupon) throw notFound("Cupom não encontrado para este evento.");
    if (coupon.disabledAt) throw new AppError("VALIDATION", "Este cupom está desativado.");
  }
  // Código público curto e aleatório; colisão é improvável, mas tenta de novo.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        const link = await tx.trackingLink.create({
          data: {
            organizationId,
            eventId,
            code: randomCode(TRACKING_LINK_CODE_LENGTH),
            name: input.name,
            utmSource: input.utmSource ?? null,
            utmMedium: input.utmMedium ?? null,
            utmCampaign: input.utmCampaign ?? null,
            utmContent: input.utmContent ?? null,
            utmTerm: input.utmTerm ?? null,
            couponId,
            createdById: actor.id,
          },
        });
        await audit(tx, {
          actorUserId: actor.id,
          organizationId,
          action: "tracking_link.created",
          entityType: "TrackingLink",
          entityId: link.id,
          metadata: { eventId, code: link.code, couponId },
        });
        return link;
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
  }
  throw new AppError("CONFLICT", "Não foi possível gerar um código para o link. Tente novamente.");
}

/** Arquivar tira o link da lista e do redirecionamento; o histórico de pedidos continua. */
export async function setTrackingLinkArchived(db: Db, actor: Actor, linkId: string, archived: boolean) {
  const link = await db.trackingLink.findUnique({ where: { id: linkId } });
  if (!link) throw notFound("Link não encontrado.");
  await assertOrgPermission(db, actor, link.organizationId, "event:write");
  if ((link.archivedAt !== null) === archived) return link;
  return db.$transaction(async (tx) => {
    const updated = await tx.trackingLink.update({ where: { id: linkId }, data: { archivedAt: archived ? new Date() : null } });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: link.organizationId,
      action: archived ? "tracking_link.archived" : "tracking_link.restored",
      entityType: "TrackingLink",
      entityId: linkId,
      metadata: { code: link.code },
    });
    return updated;
  });
}
