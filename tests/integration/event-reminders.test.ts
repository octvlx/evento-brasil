import { beforeEach, expect, it } from "vitest";
import { db, resetDb, makeUser, makeOrg, makeEvent, buyAndPay } from "../support/fixtures";
import { enqueueEventReminders, reminderLines } from "@/server/services/event-reminders";

const HOUR = 3_600_000;
beforeEach(resetDb);

/** Evento já vendido, depois trazido para começar em `hours` horas, com ingressos emitidos há 3 h. */
async function soldEvent(hours: number, buyers = 1, quantity = 2) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const users = [];
  for (let i = 0; i < buyers; i++) {
    const u = await makeUser();
    await buyAndPay(u, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity }]);
    users.push(u);
  }
  const startsAt = new Date(Date.now() + hours * HOUR);
  await db.event.update({ where: { id: event.id }, data: { salesEndAt: startsAt, startsAt, endsAt: new Date(startsAt.getTime() + 4 * HOUR) } });
  await db.issuedTicket.updateMany({ where: { eventId: event.id }, data: { issuedAt: new Date(Date.now() - 3 * HOUR) } });
  return { event, users, startsAt };
}
const reminders = () => db.emailOutbox.findMany({ where: { template: "EVENT_REMINDER" }, orderBy: { recipient: "asc" } });

it("enfileira um lembrete por titular, que expira no início, e não repete", async () => {
  const { event, users, startsAt } = await soldEvent(20, 2);
  expect(await enqueueEventReminders(db)).toEqual({ events: 1, queued: 2 });
  const jobs = await reminders();
  expect(jobs.map((j) => j.recipient).sort()).toEqual(users.map((u) => u.email.toLowerCase()).sort());
  expect(jobs.every((j) => j.expiresAt?.getTime() === startsAt.getTime())).toBe(true);
  expect(jobs[0].messageEncrypted).not.toContain(event.title); // conteúdo cifrado na fila
  // Passadas seguintes (e simultâneas) não enfileiram de novo.
  const again = await Promise.all([enqueueEventReminders(db), enqueueEventReminders(db)]);
  expect(again).toEqual([{ events: 0, queued: 0 }, { events: 0, queued: 0 }]);
  expect(await reminders()).toHaveLength(2);
});

it("fora da janela (mais de 24 h ou menos de 2 h) e evento suspenso ficam sem lembrete", async () => {
  await soldEvent(30);
  await soldEvent(1);
  const { event } = await soldEvent(20);
  const admin = await makeUser({ admin: true });
  await db.event.update({ where: { id: event.id }, data: { suspendedAt: new Date(), suspensionReason: "Teste", suspendedById: admin.id } });
  expect(await enqueueEventReminders(db)).toEqual({ events: 0, queued: 0 });
  expect(await reminders()).toHaveLength(0);
});

it("ignora ingresso revogado e ingresso recém-emitido", async () => {
  const { event, users } = await soldEvent(20, 2, 1);
  const tickets = await db.issuedTicket.findMany({ where: { eventId: event.id } });
  const revoked = tickets.find((t) => t.userId === users[0].id)!;
  const fresh = tickets.find((t) => t.userId === users[1].id)!;
  await db.issuedTicket.update({ where: { id: revoked.id }, data: { status: "REVOKED", revokedAt: new Date(), revocationReason: "ADMIN" } });
  await db.issuedTicket.update({ where: { id: fresh.id }, data: { issuedAt: new Date() } });
  expect(await enqueueEventReminders(db)).toEqual({ events: 1, queued: 0 });
  // O evento fica marcado: o ingresso recém-emitido já recebeu o e-mail dos ingressos.
  expect(await enqueueEventReminders(db)).toEqual({ events: 0, queued: 0 });
});

it("se a data do evento muda, o lembrete sai de novo para a nova data", async () => {
  const { event } = await soldEvent(20);
  expect((await enqueueEventReminders(db)).queued).toBe(1);
  const startsAt = new Date(Date.now() + 22 * HOUR);
  await db.event.update({ where: { id: event.id }, data: { salesEndAt: startsAt, startsAt, endsAt: new Date(startsAt.getTime() + 4 * HOUR) } });
  expect((await enqueueEventReminders(db)).queued).toBe(1);
  expect(await reminders()).toHaveLength(2);
});

it("texto: data no fuso do evento, local, quantidade, abertura da portaria e QR dinâmico", () => {
  const lines = reminderLines(
    {
      title: "Show",
      startsAt: new Date("2026-12-05T23:00:00Z"),
      timezone: "America/Sao_Paulo",
      checkinOpensMinutesBefore: 60,
      locationType: "VENUE",
      venue: { name: "Arena", addressLine: "Rua A, 10", district: "Centro", isFictional: false },
      city: { name: "Franca", state: "SP" },
    },
    2,
  );
  expect(lines).toEqual([
    "Quando: sábado, 5 de dezembro de 2026, às 20:00 (horário do evento).",
    "Local: Arena, Rua A, 10, Centro, Franca - SP.",
    "Você tem 2 ingressos para este evento.",
    "A entrada abre às 19:00.",
    expect.stringMatching(/print e PDF não valem/),
  ]);
  const online = reminderLines({ title: "Live", startsAt: new Date(), timezone: "America/Sao_Paulo", checkinOpensMinutesBefore: 60, locationType: "ONLINE", venue: null, city: null }, 1);
  expect(online[1]).toMatch(/^Evento online/);
  expect(online).toHaveLength(4);
});
