import { beforeEach, expect, it } from "vitest";
import { db, resetDb, makeUser, makeOrg, makeEvent } from "../support/fixtures";
import { favoriteEvents } from "@/server/services/catalog";
import {
  followedOrganizers,
  isEventFavorite,
  isFollowingOrganizer,
  newEventEmail,
  notifyFollowersOfNewEvents,
  setEventFavorite,
  setOrganizerFollow,
} from "@/server/services/favorites";
import { deleteOwnAccount } from "@/server/services/account-deletion";

beforeEach(resetDb);
const notices = () => db.emailOutbox.findMany({ where: { template: "FOLLOWED_ORGANIZER_NEW_EVENT" } });

it("salva e tira evento dos favoritos; idempotente; só evento no ar", async () => {
  const user = await makeUser();
  const org = await makeOrg(await makeUser());
  const event = await makeEvent(org);
  const draft = await makeEvent(org, { status: "DRAFT" });
  await setEventFavorite(db, user, event.id, true);
  await setEventFavorite(db, user, event.id, true);
  expect(await isEventFavorite(db, user.id, event.id)).toBe(true);
  expect((await favoriteEvents(db, user.id)).map((e) => e.id)).toEqual([event.id]);
  await expect(setEventFavorite(db, user, draft.id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await setEventFavorite(db, user, event.id, false);
  expect(await isEventFavorite(db, user.id, event.id)).toBe(false);
  // Outra pessoa não vê os favoritos desta.
  expect(await favoriteEvents(db, (await makeUser()).id)).toEqual([]);
});

it("segue e deixa de seguir; organização não aprovada é recusada", async () => {
  const user = await makeUser();
  const org = await makeOrg(await makeUser());
  const pending = await makeOrg(await makeUser(), { status: "PENDING_REVIEW" });
  await setOrganizerFollow(db, user, org.id, true);
  expect(await isFollowingOrganizer(db, user.id, org.id)).toBe(true);
  expect((await followedOrganizers(db, user.id)).map((o) => o.id)).toEqual([org.id]);
  await expect(setOrganizerFollow(db, user, pending.id, true)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await setOrganizerFollow(db, user, org.id, false);
  expect(await followedOrganizers(db, user.id)).toEqual([]);
});

it("avisa os seguidores de evento recém-publicado uma vez só, e não de evento antigo, privado ou de outro organizador", async () => {
  const org = await makeOrg(await makeUser());
  const other = await makeOrg(await makeUser());
  const [a, b, suspended] = [await makeUser(), await makeUser(), await makeUser()];
  for (const u of [a, b, suspended]) await setOrganizerFollow(db, u, org.id, true);
  await db.user.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });
  const now = new Date();
  const fresh = await makeEvent(org);
  const old = await makeEvent(org);
  const unlisted = await makeEvent(org);
  const elsewhere = await makeEvent(other);
  await db.event.updateMany({ where: { id: { in: [fresh.id, unlisted.id, elsewhere.id] } }, data: { publishedAt: now } });
  await db.event.update({ where: { id: old.id }, data: { publishedAt: new Date(now.getTime() - 5 * 86_400_000) } });
  await db.event.update({ where: { id: unlisted.id }, data: { isUnlisted: true } });

  const [first, second] = await Promise.all([notifyFollowersOfNewEvents(db), notifyFollowersOfNewEvents(db)]);
  expect(first.queued + second.queued).toBe(2);
  expect(await notifyFollowersOfNewEvents(db)).toEqual({ events: 0, queued: 0 });
  const jobs = await notices();
  expect(jobs.map((j) => j.recipient).sort()).toEqual([a.email, b.email].map((e) => e.toLowerCase()).sort());
  expect(jobs.every((j) => j.dedupeKey.startsWith(`follow-new-event:${fresh.id}:`))).toBe(true);
  expect(jobs[0].expiresAt?.getTime()).toBe(fresh.startsAt.getTime());
  // O evento de outro organizador foi marcado (sem seguidores), não fica na fila.
  expect((await db.event.findUniqueOrThrow({ where: { id: elsewhere.id } })).followersNotifiedAt).not.toBeNull();
  expect((await db.event.findUniqueOrThrow({ where: { id: old.id } })).followersNotifiedAt).toBeNull();
});

it("exclusão da conta apaga favoritos e quem a pessoa segue", async () => {
  // Conta Google: a confirmação é o e-mail.
  const user = await db.user.update({ where: { id: (await makeUser()).id }, data: { googleSubject: "google-sub-fav" } });
  const org = await makeOrg(await makeUser());
  const event = await makeEvent(org);
  await setEventFavorite(db, user, event.id, true);
  await setOrganizerFollow(db, user, org.id, true);
  await deleteOwnAccount(db, user, { email: user.email });
  expect(await db.eventFavorite.count()).toBe(0);
  expect(await db.organizerFollow.count()).toBe(0);
});

it("e-mail do aviso: organizador, data no fuso do evento, link e como deixar de seguir", () => {
  const mail = newEventEmail({
    title: "Show de Verão",
    slug: "show-de-verao",
    startsAt: new Date("2026-12-05T23:00:00Z"),
    timezone: "America/Sao_Paulo",
    locationType: "VENUE",
    organization: { name: "Org <Teste>" },
    city: { name: "Franca", state: "SP" },
  });
  expect(mail.subject).toMatch(/^Org <Teste> publicou um evento novo/);
  expect(mail.text).toContain("às 20:00");
  expect(mail.text).toContain("/eventos/show-de-verao");
  expect(mail.text).toContain("/favoritos");
  expect(mail.html).toContain("Org &lt;Teste&gt;");
  expect(mail.html).not.toContain("Org <Teste>");
});
