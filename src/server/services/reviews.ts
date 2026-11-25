// Avaliação pós-evento: quem entrou no evento (ingresso com check-in) dá uma nota de 1 a 5
// e, se quiser, um comentário, até REVIEW_WINDOW_DAYS depois do fim. Uma por pessoa e
// evento (editável no prazo). O perfil público do organizador mostra a média e os
// comentários recentes; o admin pode ocultar comentário abusivo (auditado).
import "server-only";
import type { Db } from "../db";
import { env } from "../env";
import { audit } from "../audit";
import { AppError } from "../errors";
import { escapeHtml } from "../email";
import { enqueueEmail } from "../email/outbox";
import { emailLayout } from "../email/templates";
import { assertAdminPermission, type Actor as AdminActor } from "../auth/permissions";
import { BRAND } from "@/lib/brand";

const DAY = 86_400_000;
export const REVIEW_WINDOW_DAYS = 30;
export const REVIEW_COMMENT_MAX = 1000;
/** O convite sai depois do fim do evento, e só para eventos que terminaram há até 3 dias. */
const INVITE_DELAY_MS = 2 * 3_600_000;
const INVITE_MAX_AGE_MS = 3 * DAY;
const EVENTS_PER_RUN = 10;

type Actor = { id: string };

export type ReviewEligibility =
  | { eligible: true; existing: { rating: number; comment: string | null } | null }
  | { eligible: false; reason: "NOT_ENDED" | "WINDOW_CLOSED" | "NO_CHECKIN" | "NOT_FOUND" };

/** Pode avaliar: evento terminado há menos de 30 dias e a pessoa tem ingresso com check-in nele. */
export async function reviewEligibility(db: Db, userId: string, eventId: string, now = new Date()): Promise<ReviewEligibility> {
  const event = await db.event.findFirst({
    where: { id: eventId, status: { in: ["PUBLISHED", "COMPLETED"] } },
    select: { endsAt: true },
  });
  if (!event) return { eligible: false, reason: "NOT_FOUND" };
  if (event.endsAt > now) return { eligible: false, reason: "NOT_ENDED" };
  if (now.getTime() - event.endsAt.getTime() > REVIEW_WINDOW_DAYS * DAY) return { eligible: false, reason: "WINDOW_CLOSED" };
  const attended = await db.issuedTicket.findFirst({ where: { eventId, holderUserId: userId, status: "CHECKED_IN" }, select: { id: true } });
  if (!attended) return { eligible: false, reason: "NO_CHECKIN" };
  const existing = await db.eventReview.findUnique({ where: { eventId_userId: { eventId, userId } }, select: { rating: true, comment: true } });
  return { eligible: true, existing };
}

const REASONS: Record<Exclude<ReviewEligibility, { eligible: true }>["reason"], string> = {
  NOT_FOUND: "Evento não encontrado.",
  NOT_ENDED: "A avaliação abre depois que o evento termina.",
  WINDOW_CLOSED: `O prazo para avaliar terminou (${REVIEW_WINDOW_DAYS} dias depois do evento).`,
  NO_CHECKIN: "Só quem entrou no evento pode avaliar.",
};

/** Cria ou atualiza a avaliação da pessoa. O comentário vazio vira nulo. */
export async function submitReview(db: Db, actor: Actor, eventId: string, input: { rating: number; comment?: string | null }, now = new Date()) {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new AppError("VALIDATION", "Escolha uma nota de 1 a 5.");
  const comment = input.comment?.trim() || null;
  if (comment && comment.length > REVIEW_COMMENT_MAX) throw new AppError("VALIDATION", `O comentário pode ter até ${REVIEW_COMMENT_MAX} caracteres.`);
  const check = await reviewEligibility(db, actor.id, eventId, now);
  if (!check.eligible) throw new AppError(check.reason === "NOT_FOUND" ? "NOT_FOUND" : "FORBIDDEN", REASONS[check.reason]);
  const { organizationId } = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { organizationId: true } });
  return db.eventReview.upsert({
    where: { eventId_userId: { eventId, userId: actor.id } },
    create: { eventId, organizationId, userId: actor.id, rating: input.rating, comment },
    // Editar não desfaz uma ocultação feita pela moderação.
    update: { rating: input.rating, comment },
    select: { id: true, rating: true, comment: true },
  });
}

/** "Ana Souza" → "Ana S.": o nome completo de quem avalia não aparece. */
export function reviewerDisplayName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Participante";
  // Inicial do último nome que tenha letra ("Clara (demo)" → "Clara D."; sem letra, só o primeiro nome).
  const initial = parts.slice(1).reverse().map((p) => p.match(/\p{L}/u)?.[0]).find(Boolean);
  return initial ? `${parts[0]} ${initial.toUpperCase()}.` : parts[0];
}

/** Média e total das avaliações visíveis do organizador, e os comentários mais recentes. */
export async function organizerReviewSummary(db: Db, organizationId: string, recent = 6) {
  const visible = { organizationId, hiddenAt: null };
  const [agg, rows] = await Promise.all([
    db.eventReview.aggregate({ where: visible, _avg: { rating: true }, _count: { _all: true } }),
    db.eventReview.findMany({
      where: { ...visible, comment: { not: null } },
      orderBy: { createdAt: "desc" },
      take: recent,
      select: { id: true, rating: true, comment: true, createdAt: true, user: { select: { name: true } }, event: { select: { title: true, slug: true } } },
    }),
  ]);
  return {
    count: agg._count._all,
    average: agg._avg.rating == null ? null : Math.round(agg._avg.rating * 10) / 10,
    recent: rows.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment!, createdAt: r.createdAt, author: reviewerDisplayName(r.user.name), event: r.event })),
  };
}

/** Avaliações de um evento para o admin (inclui ocultas). */
export async function adminEventReviews(db: Db, actor: AdminActor, eventId: string) {
  assertAdminPermission(actor, "events:moderate");
  return db.eventReview.findMany({
    where: { eventId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, rating: true, comment: true, createdAt: true, hiddenAt: true, hiddenReason: true, user: { select: { name: true } } },
  });
}

/** Oculta (ou volta a mostrar) uma avaliação. Exige events:moderate; sempre auditado. */
export async function setReviewHidden(db: Db, actor: AdminActor, reviewId: string, hidden: boolean, reason?: string) {
  assertAdminPermission(actor, "events:moderate");
  const note = reason?.trim();
  if (hidden && !note) throw new AppError("VALIDATION", "Informe o motivo da ocultação.");
  return db.$transaction(async (tx) => {
    const review = await tx.eventReview.findUnique({ where: { id: reviewId }, select: { id: true, organizationId: true, hiddenAt: true } });
    if (!review) throw new AppError("NOT_FOUND", "Avaliação não encontrada.");
    if (!!review.hiddenAt === hidden) return review;
    const updated = await tx.eventReview.update({
      where: { id: reviewId },
      data: hidden ? { hiddenAt: new Date(), hiddenById: actor.id, hiddenReason: note!.slice(0, 500) } : { hiddenAt: null, hiddenById: null, hiddenReason: null },
      select: { id: true, organizationId: true, hiddenAt: true },
    });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: review.organizationId,
      action: hidden ? "review.hidden" : "review.unhidden",
      entityType: "EventReview",
      entityId: reviewId,
      metadata: hidden ? { reason: note!.slice(0, 500) } : undefined,
    });
    return updated;
  });
}

// ───────────────────────────── Convite por e-mail ─────────────────────────────

/** E-mail "como foi o evento?". Exportado para teste. */
export function reviewInviteEmail(e: { title: string; slug: string; organization: { name: string } }) {
  const url = `${env().APP_URL}/eventos/${e.slug}#avaliar`;
  const lines = [
    `Você esteve em ${e.title}. Conte como foi: sua nota ajuda outras pessoas a escolher e ajuda ${e.organization.name} a melhorar.`,
    `Leva menos de um minuto. A avaliação fica aberta por ${REVIEW_WINDOW_DAYS} dias.`,
  ];
  return {
    subject: `Como foi ${e.title}? | ${BRAND.name}`,
    html: emailLayout("Como foi o evento?", lines.map((l) => "<p>" + escapeHtml(l) + "</p>").join(""), { label: "Avaliar o evento", url }),
    text: ["Como foi o evento?", ...lines, "Avaliar o evento: " + url].join("\n"),
  };
}

/**
 * Convida quem entrou no evento a avaliar, um pouco depois do fim. Idempotente: o
 * marcador Event.reviewInviteSentAt (sob trava do evento) e a dedupeKey por evento e
 * pessoa. Só eventos terminados há até 3 dias (o deploy não convida para eventos antigos).
 */
export async function sendReviewInvites(db: Db, now = new Date()) {
  const due = await db.event.findMany({
    where: {
      status: { in: ["PUBLISHED", "COMPLETED"] },
      reviewInviteSentAt: null,
      endsAt: { lte: new Date(now.getTime() - INVITE_DELAY_MS), gt: new Date(now.getTime() - INVITE_MAX_AGE_MS) },
    },
    select: { id: true },
    orderBy: { endsAt: "asc" },
    take: EVENTS_PER_RUN,
  });
  let events = 0,
    queued = 0;
  for (const { id } of due) {
    const n = await db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "Event" WHERE id=$1 FOR UPDATE', id);
        const e = await tx.event.findFirst({
          where: { id, reviewInviteSentAt: null },
          select: { title: true, slug: true, endsAt: true, organization: { select: { name: true } } },
        });
        if (!e) return null;
        const tickets = await tx.issuedTicket.findMany({
          where: { eventId: id, status: "CHECKED_IN", piiRedactedAt: null, holder: { status: "ACTIVE", anonymizedAt: null } },
          select: { holderUserId: true, holder: { select: { email: true } } },
          distinct: ["holderUserId"],
        });
        const message = reviewInviteEmail(e);
        for (const t of tickets)
          await enqueueEmail(tx, {
            dedupeKey: `review-invite:${id}:${t.holderUserId}`,
            template: "EVENT_REVIEW_INVITE",
            recipient: t.holder.email,
            message,
            expiresAt: new Date(e.endsAt.getTime() + REVIEW_WINDOW_DAYS * DAY),
          });
        await tx.event.update({ where: { id }, data: { reviewInviteSentAt: now } });
        return tickets.length;
      },
      { timeout: 120_000 },
    );
    if (n !== null) {
      events++;
      queued += n;
    }
  }
  return { events, queued };
}
