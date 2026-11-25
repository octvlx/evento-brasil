// Favoritos (eventos salvos) e seguir organizadores. Quem segue recebe um e-mail quando
// o organizador publica um evento novo (cron de manutenção, `notifyFollowersOfNewEvents`).
import "server-only";
import type { Db } from "../db";
import { env } from "../env";
import { AppError } from "../errors";
import { escapeHtml } from "../email";
import { enqueueEmail } from "../email/outbox";
import { emailLayout } from "../email/templates";
import { BRAND, BRAND_COLORS } from "@/lib/brand";
import { formatDateLong, formatTime } from "@/lib/datetime";
import { publicEventWhere, reachableEventWhere } from "./catalog";

type Actor = { id: string };

/** Salva ou tira o evento dos favoritos. Só salva evento que está no ar; tirar vale sempre. */
export async function setEventFavorite(db: Db, actor: Actor, eventId: string, on: boolean) {
  if (!on) {
    await db.eventFavorite.deleteMany({ where: { userId: actor.id, eventId } });
    return { favorite: false };
  }
  const event = await db.event.findFirst({ where: { id: eventId, ...reachableEventWhere() }, select: { id: true } });
  if (!event) throw new AppError("NOT_FOUND", "Este evento não está disponível.");
  await db.eventFavorite.upsert({ where: { userId_eventId: { userId: actor.id, eventId } }, create: { userId: actor.id, eventId }, update: {} });
  return { favorite: true };
}

/** Segue ou deixa de seguir o organizador. Só segue organização aprovada e não excluída. */
export async function setOrganizerFollow(db: Db, actor: Actor, organizationId: string, on: boolean) {
  if (!on) {
    await db.organizerFollow.deleteMany({ where: { userId: actor.id, organizationId } });
    return { following: false };
  }
  const org = await db.organization.findFirst({ where: { id: organizationId, status: "APPROVED", deletedAt: null }, select: { id: true } });
  if (!org) throw new AppError("NOT_FOUND", "Este organizador não está disponível.");
  await db.organizerFollow.upsert({
    where: { userId_organizationId: { userId: actor.id, organizationId } },
    create: { userId: actor.id, organizationId },
    update: {},
  });
  return { following: true };
}

export async function isEventFavorite(db: Db, userId: string, eventId: string) {
  return !!(await db.eventFavorite.findUnique({ where: { userId_eventId: { userId, eventId } }, select: { eventId: true } }));
}

export async function isFollowingOrganizer(db: Db, userId: string, organizationId: string) {
  return !!(await db.organizerFollow.findUnique({ where: { userId_organizationId: { userId, organizationId } }, select: { userId: true } }));
}

/** Organizadores seguidos (aprovados e não excluídos), do mais recente ao mais antigo. */
export async function followedOrganizers(db: Db, userId: string) {
  const rows = await db.organizerFollow.findMany({
    where: { userId, organization: { status: "APPROVED", deletedAt: null } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { organization: { select: { id: true, name: true, slug: true, logoUrl: true, city: { select: { name: true, state: true } } } } },
  });
  return rows.map((r) => r.organization);
}

// ───────────────────────────── Aviso de evento novo ─────────────────────────────

/**
 * Só avisa de evento publicado há pouco. Evita, no deploy, um e-mail sobre cada evento
 * que já estava no ar, e um aviso atrasado sobre evento antigo.
 */
export const FOLLOW_NOTICE_MAX_AGE_HOURS = 72;
const EVENTS_PER_RUN = 10;

type NoticeEvent = {
  title: string;
  slug: string;
  startsAt: Date;
  timezone: string;
  locationType: "VENUE" | "ONLINE";
  organization: { name: string };
  city: { name: string; state: string } | null;
};

/** E-mail "evento novo de quem você segue". Exportado para teste. */
export function newEventEmail(e: NoticeEvent) {
  const url = `${env().APP_URL}/eventos/${e.slug}`;
  const lines = [
    `${e.organization.name} publicou um evento novo.`,
    `Quando: ${formatDateLong(e.startsAt, e.timezone)}, às ${formatTime(e.startsAt, e.timezone)} (horário do evento).`,
    e.locationType === "ONLINE" ? "Evento online." : e.city ? `Onde: ${e.city.name} - ${e.city.state}.` : null,
  ].filter((l): l is string => !!l);
  const unfollow = `Você recebe este aviso porque segue ${e.organization.name}. Para não receber mais, deixe de seguir em ${env().APP_URL}/favoritos.`;
  return {
    subject: `${e.organization.name} publicou um evento novo | ${BRAND.name}`,
    html: emailLayout(
      e.title,
      lines.map((l) => "<p>" + escapeHtml(l) + "</p>").join("") + `<p style="font-size:12px;color:${BRAND_COLORS.mutedText}">${escapeHtml(unfollow)}</p>`,
      { label: "Ver evento", url },
    ),
    text: [e.title, ...lines, "Ver evento: " + url, "", unfollow].join("\n"),
  };
}

/**
 * Enfileira o aviso aos seguidores do organizador de cada evento recém-publicado e
 * listado. Idempotente: o marcador Event.followersNotifiedAt (gravado sob trava do
 * evento) e a dedupeKey por evento e pessoa. O e-mail expira no início do evento.
 */
export async function notifyFollowersOfNewEvents(db: Db, now = new Date()) {
  const due = await db.event.findMany({
    where: {
      ...publicEventWhere(now),
      startsAt: { gt: now },
      followersNotifiedAt: null,
      publishedAt: { gte: new Date(now.getTime() - FOLLOW_NOTICE_MAX_AGE_HOURS * 3_600_000) },
    },
    select: { id: true },
    orderBy: { publishedAt: "asc" },
    take: EVENTS_PER_RUN,
  });
  let events = 0,
    queued = 0;
  for (const { id } of due) {
    const n = await db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM "Event" WHERE id=$1 FOR UPDATE', id);
        const e = await tx.event.findFirst({
          where: { id, ...publicEventWhere(now), startsAt: { gt: now }, followersNotifiedAt: null },
          select: {
            organizationId: true,
            title: true,
            slug: true,
            startsAt: true,
            timezone: true,
            locationType: true,
            organization: { select: { name: true } },
            city: { select: { name: true, state: true } },
            venue: { select: { city: { select: { name: true, state: true } } } },
          },
        });
        if (!e) return null;
        const followers = await tx.organizerFollow.findMany({
          where: { organizationId: e.organizationId, user: { status: "ACTIVE", anonymizedAt: null } },
          select: { userId: true, user: { select: { email: true } } },
        });
        const message = newEventEmail({ ...e, city: e.venue?.city ?? e.city });
        for (const f of followers)
          await enqueueEmail(tx, {
            dedupeKey: `follow-new-event:${id}:${f.userId}`,
            template: "FOLLOWED_ORGANIZER_NEW_EVENT",
            recipient: f.user.email,
            message,
            expiresAt: e.startsAt,
          });
        await tx.event.update({ where: { id }, data: { followersNotifiedAt: now } });
        return followers.length;
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
