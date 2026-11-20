// Check-in: janela de abertura por evento, aviso de ingresso de teste, histórico
// completo (filtros, totais, por hora, CSV), lista /check-in por papel e lacunas de
// testes antigas (12 h após o término, PDF sem ingresso cancelado).
import { beforeEach, describe, expect, it } from "vitest";
import { assignStaffToEvent, changeMemberRole } from "@/server/services/organizers";
import {
  checkInTicket,
  checkinHistoryReport,
  checkinOfflinePackage,
  exportCheckinHistory,
  listCheckinEvents,
  parseCheckinHistoryFilters,
  setCheckinOpening,
} from "@/server/services/checkin";
import { loadPdfTickets } from "@/server/services/notifications";
import { checkinHistoryToCsv } from "@/server/services/reports";
import { qrPayload } from "@/server/services/tickets";
import { CHECKIN_GRACE_MS } from "@/lib/event-lifecycle";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const HOUR = 3_600_000;

async function setup(opts: { checkinOpensMinutesBefore?: number; quantity?: number } = {}) {
  const owner = await makeUser();
  const staff = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: staff.id, role: "CHECKIN_STAFF" }] });
  const event = await makeEvent(org, { checkinOpensMinutesBefore: opts.checkinOpensMinutesBefore });
  await assignStaffToEvent(db, owner, event.id, staff.id, true);
  const { order } = await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: opts.quantity ?? 3 }]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
  return { owner, staff, org, event, order, tickets };
}

describe("janela de abertura da portaria", () => {
  it("antes da abertura recusa sem gastar o ingresso e diz quando abre; na abertura admite", async () => {
    const { owner, event, tickets } = await setup({ checkinOpensMinutesBefore: 360 });
    const opensAt = new Date(event.startsAt.getTime() - 6 * HOUR);
    const early = await checkInTicket(db, owner, event.id, qrPayload(tickets[0]), new Date(opensAt.getTime() - 60_000));
    expect(early).toMatchObject({ result: "EVENT_NOT_ACTIVE", opensAt: opensAt.toISOString() });
    expect(early.message).toMatch(/ainda não abriu: abre/);
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } })).status).toBe("VALID");
    expect((await checkInTicket(db, owner, event.id, qrPayload(tickets[0]), opensAt)).result).toBe("ADMITTED");
  });

  it("continua aceitando até 12 h depois do término e fecha depois, sem 'abre às'", async () => {
    const { owner, event, tickets } = await setup({ checkinOpensMinutesBefore: 0 });
    const late = new Date(event.endsAt.getTime() + CHECKIN_GRACE_MS - HOUR);
    expect((await checkInTicket(db, owner, event.id, qrPayload(tickets[0]), late)).result).toBe("ADMITTED");
    const closed = await checkInTicket(db, owner, event.id, qrPayload(tickets[1]), new Date(event.endsAt.getTime() + CHECKIN_GRACE_MS));
    expect(closed.result).toBe("EVENT_NOT_ACTIVE");
    expect(closed.opensAt).toBeUndefined();
  });

  it("lista offline: pode ser baixada nas 12 h antes da abertura e leva a abertura; antes disso, não", async () => {
    const { staff, event } = await setup({ checkinOpensMinutesBefore: 60 });
    const opensAt = new Date(event.startsAt.getTime() - HOUR);
    await expect(checkinOfflinePackage(db, staff, event.id, new Date(opensAt.getTime() - 13 * HOUR))).rejects.toMatchObject({ code: "INVALID_STATE", message: expect.stringMatching(/abre .*12 horas/) });
    const pkg = await checkinOfflinePackage(db, staff, event.id, new Date(opensAt.getTime() - 2 * HOUR));
    expect(pkg.opensAt).toBe(opensAt.toISOString());
    expect(pkg.tickets).toHaveLength(3);
  });

  it("quem edita o evento ajusta a abertura (auditado, sem registro quando nada muda); portaria e fora do limite, não", async () => {
    const { owner, staff, event } = await setup();
    await expect(setCheckinOpening(db, staff, event.id, 60)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setCheckinOpening(db, owner, event.id, 7 * 24 * 60 + 1)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setCheckinOpening(db, owner, event.id, -5)).rejects.toMatchObject({ code: "VALIDATION" });
    await setCheckinOpening(db, owner, event.id, 120);
    await setCheckinOpening(db, owner, event.id, 120);
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).checkinOpensMinutesBefore).toBe(120);
    const logs = await db.auditLog.findMany({ where: { entityId: event.id, action: "event.checkin_opening" } });
    expect(logs.map((l) => l.metadata)).toEqual([{ minutes: 120, previous: 525_600 }]);
  });

  it("evento criado sem informar a abertura usa o padrão de 6 h", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const ev = await makeEvent(org);
    const [row] = await db.$queryRaw<{ d: string }[]>`SELECT column_default AS d FROM information_schema.columns WHERE table_name = 'Event' AND column_name = 'checkinOpensMinutesBefore'`;
    expect(row.d).toBe("360");
    expect(ev.checkinOpensMinutesBefore).toBe(525_600); // fixture: portaria aberta nos testes
  });
});

describe("ingresso de pagamento simulado", () => {
  it("a portaria e a lista offline sabem que é de teste", async () => {
    const { owner, staff, event, order, tickets } = await setup();
    expect(order.isSimulated).toBe(true);
    const r = await checkInTicket(db, owner, event.id, qrPayload(tickets[0]));
    expect(r.ticket?.simulated).toBe(true);
    const pkg = await checkinOfflinePackage(db, staff, event.id);
    expect(pkg.tickets.every((t) => t.sim === true)).toBe(true);
    await db.order.update({ where: { id: order.id }, data: { isSimulated: false } });
    expect((await checkInTicket(db, owner, event.id, qrPayload(tickets[1]))).ticket?.simulated).toBe(false);
  });
});

describe("histórico completo", () => {
  it("totais por resultado, filtros, entradas por hora (fuso do evento) e CSV registrado", async () => {
    const { owner, staff, event, tickets } = await setup();
    const at = new Date("2026-11-20T23:10:00Z"); // 20:10 em São Paulo
    await checkInTicket(db, staff, event.id, qrPayload(tickets[0]), at);
    await checkInTicket(db, staff, event.id, qrPayload(tickets[0]), new Date(at.getTime() + 60_000));
    await checkInTicket(db, owner, event.id, qrPayload(tickets[1]), new Date(at.getTime() + HOUR));
    await checkInTicket(db, owner, event.id, "lixo", new Date(at.getTime() + HOUR));

    const all = await checkinHistoryReport(db, owner, event.id);
    expect(all.counts).toMatchObject({ ADMITTED: 2, DUPLICATE: 1, INVALID: 1, REVOKED: 0 });
    expect(all.total).toBe(4);
    expect(all.perHour).toEqual([
      { hour: "2026-11-20 20:00", admitted: 1 },
      { hour: "2026-11-20 21:00", admitted: 1 },
    ]);
    const dup = await checkinHistoryReport(db, owner, event.id, parseCheckinHistoryFilters({ resultado: "DUPLICATE" }));
    expect(dup.rows.map((r) => r.result)).toEqual(["DUPLICATE"]);
    expect((await checkinHistoryReport(db, owner, event.id, parseCheckinHistoryFilters({ origem: "offline" }))).total).toBe(0);
    expect(parseCheckinHistoryFilters({ resultado: "QUALQUER", origem: "x" })).toEqual({ result: undefined, offline: undefined });
    const page2 = await checkinHistoryReport(db, owner, event.id, {}, { page: 2, pageSize: 3 });
    expect(page2).toMatchObject({ page: 2, pageCount: 2 });
    expect(page2.rows).toHaveLength(1);

    // Equipe de portaria não vê o histórico completo nem exporta.
    await expect(checkinHistoryReport(db, staff, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(exportCheckinHistory(db, staff, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const exp = await exportCheckinHistory(db, owner, event.id, { result: "ADMITTED" });
    const csv = checkinHistoryToCsv(exp.items, exp.timezone, exp.truncated).replace(/^﻿/, "").split("\r\n");
    expect(csv[0]).toBe('"Quando","Resultado","Código do ingresso","Titular","Leitor (equipe)","Origem","Resultado no aparelho","Divergência"');
    expect(csv).toHaveLength(3);
    expect(csv[1]).toContain(`"${tickets[0].code}"`);
    expect(csv[1]).toContain('"Entrada liberada"');
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "checkin.history_exported", entityId: event.id } });
    expect(log).toMatchObject({ actorUserId: owner.id, metadata: { rows: 2, truncated: false, result: "ADMITTED", offline: null } });
  });
});

describe("lista /check-in por papel", () => {
  it("dono vê todos os eventos da organização; portaria só os atribuídos e só enquanto for portaria", async () => {
    const { owner, staff, org, event } = await setup();
    const other = await makeEvent(org);
    const ended = await makeEvent(org, { startsAt: new Date(Date.now() - 30 * HOUR), salesStartAt: new Date(Date.now() - 48 * HOUR) }); // terminou há 26 h
    const ids = async (userId: string) => (await listCheckinEvents(db, userId)).map((e) => e.id).sort();
    expect(await ids(owner.id)).toEqual([event.id, other.id].sort());
    expect(await ids(staff.id)).toEqual([event.id]);
    expect(await ids((await makeUser()).id)).toEqual([]);
    // Mudou de papel: a atribuição antiga não aparece mais (o leitor também recusaria).
    await changeMemberRole(db, owner, org.id, staff.id, "FINANCE");
    expect(await ids(staff.id)).toEqual([]);
    expect((await listCheckinEvents(db, owner.id)).some((e) => e.id === ended.id)).toBe(false);
  });
});

describe("PDF e ingresso cancelado", () => {
  it("o PDF leva os ingressos válidos e usados, nunca os cancelados", async () => {
    const { owner, event, order, tickets } = await setup();
    await checkInTicket(db, owner, event.id, qrPayload(tickets[0]));
    await db.issuedTicket.update({ where: { id: tickets[1].id }, data: { status: "REVOKED", revokedAt: new Date(), revocationReason: "REFUNDED" } });
    const codes = (await loadPdfTickets(db, { orderId: order.id })).map((t) => t.code).sort();
    expect(codes).toEqual([tickets[0].code, tickets[2].code].sort());
    expect(await loadPdfTickets(db, { code: tickets[1].code })).toEqual([]);
  });
});
