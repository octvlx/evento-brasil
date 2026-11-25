import { beforeEach, expect, it } from "vitest";
import { db, resetDb, makeUser, makeOrg, makeEvent, buyAndPay } from "../support/fixtures";
import {
  organizerReviewSummary,
  reviewEligibility,
  reviewerDisplayName,
  reviewInviteEmail,
  sendReviewInvites,
  setReviewHidden,
  submitReview,
} from "@/server/services/reviews";
import { deleteOwnAccount } from "@/server/services/account-deletion";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
beforeEach(resetDb);

/** Evento vendido e depois levado ao passado (terminou há `endedAgo` ms); `entered` fez check-in. */
async function pastEvent(endedAgo: number) {
  const org = await makeOrg(await makeUser());
  const event = await makeEvent(org);
  const entered = await makeUser();
  const absent = await makeUser();
  await buyAndPay(entered, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  await buyAndPay(absent, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  const endsAt = new Date(Date.now() - endedAgo);
  const startsAt = new Date(endsAt.getTime() - 4 * HOUR);
  await db.event.update({ where: { id: event.id }, data: { salesStartAt: new Date(startsAt.getTime() - 10 * DAY), salesEndAt: startsAt, startsAt, endsAt } });
  await db.issuedTicket.updateMany({ where: { eventId: event.id, holderUserId: entered.id }, data: { status: "CHECKED_IN", checkedInAt: startsAt } });
  return { org, event, entered, absent };
}

it("só quem entrou avalia, depois do fim e até 30 dias; editar atualiza a mesma avaliação", async () => {
  const { org, event, entered, absent } = await pastEvent(DAY);
  expect(await reviewEligibility(db, absent.id, event.id)).toEqual({ eligible: false, reason: "NO_CHECKIN" });
  await expect(submitReview(db, absent, event.id, { rating: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(submitReview(db, entered, event.id, { rating: 6 })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(submitReview(db, entered, event.id, { rating: 4, comment: "x".repeat(1001) })).rejects.toMatchObject({ code: "VALIDATION" });

  await submitReview(db, entered, event.id, { rating: 3, comment: "  Bom  " });
  await submitReview(db, entered, event.id, { rating: 5, comment: "Excelente!" });
  const rows = await db.eventReview.findMany();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ rating: 5, comment: "Excelente!", organizationId: org.id });
  expect(await reviewEligibility(db, entered.id, event.id)).toEqual({ eligible: true, existing: { rating: 5, comment: "Excelente!" } });

  // Prazo de 30 dias e evento ainda não terminado.
  const later = new Date(Date.now() + 31 * DAY);
  expect(await reviewEligibility(db, entered.id, event.id, later)).toEqual({ eligible: false, reason: "WINDOW_CLOSED" });
  const future = await makeEvent(org);
  expect(await reviewEligibility(db, entered.id, future.id)).toEqual({ eligible: false, reason: "NOT_ENDED" });
});

it("o banco recusa nota fora de 1–5 e ocultação sem motivo", async () => {
  const { org, event, entered } = await pastEvent(DAY);
  await expect(db.eventReview.create({ data: { eventId: event.id, organizationId: org.id, userId: entered.id, rating: 0 } })).rejects.toThrow(/EventReview_rating_range/);
  const r = await db.eventReview.create({ data: { eventId: event.id, organizationId: org.id, userId: entered.id, rating: 4 } });
  await expect(db.eventReview.update({ where: { id: r.id }, data: { hiddenAt: new Date() } })).rejects.toThrow(/EventReview_hidden_complete/);
});

it("perfil: média, total e comentários recentes sem os ocultos; ocultar exige motivo e fica na auditoria", async () => {
  const { org, event, entered } = await pastEvent(DAY);
  const second = await makeUser();
  await db.user.update({ where: { id: second.id }, data: { name: "Ana Maria Souza" } });
  // Avaliação de outra pessoa gravada direto (a elegibilidade tem teste próprio).
  await db.eventReview.create({ data: { eventId: event.id, organizationId: org.id, userId: second.id, rating: 4, comment: "Gostei muito" } });
  const mine = await submitReview(db, entered, event.id, { rating: 1, comment: "Ofensa" });

  let summary = await organizerReviewSummary(db, org.id);
  expect(summary).toMatchObject({ count: 2, average: 2.5 });
  expect(summary.recent.map((r) => r.comment)).toEqual(["Ofensa", "Gostei muito"]);
  expect(summary.recent[1].author).toBe("Ana S.");

  const admin = await makeUser({ admin: true });
  await expect(setReviewHidden(db, admin, mine.id, true)).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(setReviewHidden(db, entered, mine.id, true, "abuso")).rejects.toMatchObject({ code: "FORBIDDEN" });
  await setReviewHidden(db, admin, mine.id, true, "Linguagem ofensiva");
  summary = await organizerReviewSummary(db, org.id);
  expect(summary).toMatchObject({ count: 1, average: 4 });
  expect(await db.auditLog.findFirst({ where: { action: "review.hidden", entityId: mine.id } })).toMatchObject({ actorUserId: admin.id });
  // Editar não desfaz a ocultação.
  await submitReview(db, entered, event.id, { rating: 2, comment: "Editado" });
  expect((await db.eventReview.findUniqueOrThrow({ where: { id: mine.id } })).hiddenAt).not.toBeNull();
});

it("convite por e-mail: só a quem entrou, uma vez, e só para evento terminado há pouco", async () => {
  const { event, entered } = await pastEvent(5 * HOUR);
  const old = await pastEvent(5 * DAY);
  const fresh = await pastEvent(HOUR); // terminou há menos de 2 h: ainda não
  const [a, b] = await Promise.all([sendReviewInvites(db), sendReviewInvites(db)]);
  expect(a.queued + b.queued).toBe(1);
  expect(await sendReviewInvites(db)).toEqual({ events: 0, queued: 0 });
  const jobs = await db.emailOutbox.findMany({ where: { template: "EVENT_REVIEW_INVITE" } });
  expect(jobs.map((j) => j.dedupeKey)).toEqual([`review-invite:${event.id}:${entered.id}`]);
  expect((await db.event.findUniqueOrThrow({ where: { id: old.event.id } })).reviewInviteSentAt).toBeNull();
  expect((await db.event.findUniqueOrThrow({ where: { id: fresh.event.id } })).reviewInviteSentAt).toBeNull();
});

it("exclusão da conta apaga as avaliações da pessoa", async () => {
  const { event, entered } = await pastEvent(DAY);
  await submitReview(db, entered, event.id, { rating: 5 });
  const user = await db.user.update({ where: { id: entered.id }, data: { googleSubject: "google-sub-review" } });
  await deleteOwnAccount(db, user, { email: user.email });
  expect(await db.eventReview.count()).toBe(0);
});

it("nome exibido e e-mail do convite", () => {
  expect(reviewerDisplayName("Ana Maria Souza")).toBe("Ana S.");
  expect(reviewerDisplayName("Ana")).toBe("Ana");
  expect(reviewerDisplayName("  ")).toBe("Participante");
  expect(reviewerDisplayName("Clara (demo)")).toBe("Clara D.");
  expect(reviewerDisplayName("Clara 2")).toBe("Clara");
  const mail = reviewInviteEmail({ title: "Show <1>", slug: "show-1", organization: { name: "Org" } });
  expect(mail.text).toContain("/eventos/show-1#avaliar");
  expect(mail.html).toContain("Show &lt;1&gt;");
});
