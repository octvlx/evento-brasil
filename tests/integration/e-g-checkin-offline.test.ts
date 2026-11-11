// Check-in offline: a lista baixada só tem hashes (o QR não pode ser recriado), segue as
// permissões do leitor, e a sincronização passa pelo MESMO checkInTicket atômico — dois
// aparelhos offline que liberaram o mesmo ingresso resultam numa só entrada e um conflito.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cancelEvent } from "@/server/services/cancellation";
import { checkInTicket, checkinOfflinePackage, listOfflineDivergences, offlineTokenHash, syncOfflineCheckins } from "@/server/services/checkin";
import { qrPayload } from "@/server/services/tickets";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup() {
  const owner = await makeUser();
  const staff = await makeUser();
  const otherStaff = await makeUser();
  const unassigned = await makeUser();
  const org = await makeOrg(owner, {
    extraMembers: [
      { userId: staff.id, role: "CHECKIN_STAFF" },
      { userId: otherStaff.id, role: "CHECKIN_STAFF" },
      { userId: unassigned.id, role: "CHECKIN_STAFF" },
    ],
  });
  const event = await makeEvent(org);
  for (const u of [staff, otherStaff]) await db.eventStaffAssignment.create({ data: { eventId: event.id, userId: u.id, assignedById: owner.id } });
  const customer = await makeUser();
  const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 3 }]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { code: "asc" } });
  return { owner, staff, otherStaff, unassigned, event, tickets, customer };
}

describe("check-in offline: lista baixada", () => {
  it("traz só hashes dos tokens, a situação atual e os dados que a portaria já vê", async () => {
    const { staff, event, tickets } = await setup();
    await checkInTicket(db, staff, event.id, qrPayload(tickets[0]));
    const pkg = await checkinOfflinePackage(db, staff, event.id);
    expect(pkg.tickets).toHaveLength(3);
    const byCode = new Map(pkg.tickets.map((t) => [t.code, t]));
    expect(byCode.get(tickets[0].code)?.status).toBe("CHECKED_IN");
    expect(byCode.get(tickets[1].code)?.status).toBe("VALID");
    // Hash = SHA-256 do token (o mesmo que o aparelho calcula); o token nunca sai.
    expect(byCode.get(tickets[1].code)?.h).toBe(createHash("sha256").update(tickets[1].validationToken).digest("hex"));
    expect(offlineTokenHash(tickets[1].validationToken)).toBe(byCode.get(tickets[1].code)?.h);
    const json = JSON.stringify(pkg);
    for (const t of tickets) expect(json).not.toContain(t.validationToken);
    expect(new Date(pkg.validUntil).getTime() - new Date(pkg.generatedAt).getTime()).toBe(12 * 3600_000);
  });

  it("mesmas permissões do leitor; evento fora da janela não tem lista", async () => {
    const { owner, unassigned, customer, event } = await setup();
    await expect(checkinOfflinePackage(db, unassigned, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkinOfflinePackage(db, customer, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await cancelEvent(db, adapter, owner, event.id, "Chuva");
    await expect(checkinOfflinePackage(db, owner, event.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("check-in offline: sincronização", () => {
  it("dois aparelhos liberaram o mesmo ingresso offline: uma entrada e um conflito", async () => {
    const { staff, otherStaff, event, tickets } = await setup();
    const payload = qrPayload(tickets[0]);
    const t1 = new Date(Date.now() - 10 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 9 * 60_000).toISOString();
    const a = await syncOfflineCheckins(db, staff, event.id, [{ payload, scannedAt: t1, localResult: "ADMITTED" }, { payload: qrPayload(tickets[1]), scannedAt: t1, localResult: "ADMITTED" }]);
    expect(a.items.map((i) => [i.result, i.conflict])).toEqual([
      ["ADMITTED", false],
      ["ADMITTED", false],
    ]);
    const b = await syncOfflineCheckins(db, otherStaff, event.id, [{ payload, scannedAt: t2, localResult: "ADMITTED" }]);
    expect(b.items[0]).toMatchObject({ result: "DUPLICATE", conflict: true, code: tickets[0].code });
    expect(b.counters).toEqual({ admitted: 2, total: 3 });

    // Registro: hora do aparelho (dentro do limite) e marca de offline.
    const t = await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } });
    expect(t.checkedInAt?.toISOString()).toBe(t1);
    const logs = await db.ticketCheckin.findMany({ where: { ticketId: tickets[0].id }, orderBy: { scannedAt: "asc" } });
    expect(logs.map((l) => [l.result, l.offline])).toEqual([
      ["ADMITTED", true],
      ["DUPLICATE", true],
    ]);
  });

  it("revogado depois do download não entra; hora do aparelho fora do limite vira a do servidor", async () => {
    const { owner, staff, event, tickets } = await setup();
    await db.issuedTicket.update({ where: { id: tickets[2].id }, data: { status: "REVOKED" } });
    const future = new Date(Date.now() + 3600_000).toISOString();
    const r = await syncOfflineCheckins(db, staff, event.id, [
      { payload: qrPayload(tickets[2]), scannedAt: new Date().toISOString(), localResult: "ADMITTED" },
      { payload: qrPayload(tickets[1]), scannedAt: future, localResult: "ADMITTED" },
      { payload: "lixo", scannedAt: "ontem", localResult: "INVALID" },
    ]);
    expect(r.items.map((i) => [i.result, i.conflict])).toEqual([
      ["REVOKED", true],
      ["ADMITTED", false],
      ["INVALID", false],
    ]);
    const admittedAt = (await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[1].id } })).checkedInAt!;
    expect(admittedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Math.abs(admittedAt.getTime() - Date.now())).toBeLessThan(60_000);
    void owner;
  });

  it("recusado na porta com ingresso válido: a sincronização NÃO dá entrada e marca a divergência", async () => {
    const { staff, event, tickets } = await setup();
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    // Ex.: ingresso comprado depois do download (fora da lista) ou lista vencida no aparelho.
    const r = await syncOfflineCheckins(db, staff, event.id, [
      { payload: qrPayload(tickets[0]), scannedAt: at, localResult: "INVALID" },
      { payload: qrPayload(tickets[1]), scannedAt: at, localResult: "EVENT_NOT_ACTIVE" },
    ]);
    expect(r.items.map((i) => [i.result, i.conflict, i.divergence])).toEqual([
      ["INVALID", false, "REFUSED_BUT_VALID"],
      ["EVENT_NOT_ACTIVE", false, "REFUSED_BUT_VALID"],
    ]);
    expect(r.counters).toEqual({ admitted: 0, total: 3 });
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } })).status).toBe("VALID");
    // A pessoa volta com internet: entra normalmente (não vira "JÁ UTILIZADO").
    expect((await checkInTicket(db, staff, event.id, qrPayload(tickets[0]))).result).toBe("ADMITTED");
  });

  it("leituras que concordam não geram divergência; recusas corretas também não", async () => {
    const { staff, event, tickets } = await setup();
    await db.issuedTicket.update({ where: { id: tickets[2].id }, data: { status: "REVOKED" } });
    const now = new Date().toISOString();
    const r = await syncOfflineCheckins(db, staff, event.id, [
      { payload: qrPayload(tickets[0]), scannedAt: now, localResult: "ADMITTED" },
      { payload: qrPayload(tickets[0]), scannedAt: now, localResult: "DUPLICATE" },
      { payload: qrPayload(tickets[2]), scannedAt: now, localResult: "REVOKED" },
      { payload: "lixo", scannedAt: now, localResult: "INVALID" },
    ]);
    expect(r.items.map((i) => i.divergence)).toEqual([undefined, undefined, undefined, undefined]);
    expect(await db.ticketCheckin.count({ where: { divergence: { not: null } } })).toBe(0);
    expect((await db.ticketCheckin.findMany({ orderBy: { id: "asc" } })).every((l) => l.offline && l.offlineLocalResult)).toBe(true);
  });

  it("organizador lista as divergências; portaria e quem não é da equipe não", async () => {
    const { owner, staff, otherStaff, customer, event, tickets } = await setup();
    const t1 = new Date(Date.now() - 10 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 5 * 60_000).toISOString();
    await syncOfflineCheckins(db, staff, event.id, [{ payload: qrPayload(tickets[0]), scannedAt: t1, localResult: "ADMITTED" }]);
    await syncOfflineCheckins(db, otherStaff, event.id, [
      { payload: qrPayload(tickets[0]), scannedAt: t2, localResult: "ADMITTED" },
      { payload: qrPayload(tickets[1]), scannedAt: t2, localResult: "INVALID" },
    ]);
    // Leitura online nunca entra na lista.
    await checkInTicket(db, staff, event.id, qrPayload(tickets[0]));

    const rows = await listOfflineDivergences(db, owner, event.id);
    expect(rows.map((d) => [d.divergence, d.localResult, d.result, d.ticket?.code]).sort()).toEqual(
      [
        ["ADMITTED_BUT_REJECTED", "ADMITTED", "DUPLICATE", tickets[0].code],
        ["REFUSED_BUT_VALID", "INVALID", "INVALID", tickets[1].code],
      ].sort(),
    );
    const dup = rows.find((d) => d.divergence === "ADMITTED_BUT_REJECTED")!;
    expect(dup.ticket?.checkedInAt?.toISOString()).toBe(t1);
    expect(dup.scannedBy).toBe(otherStaff.name);

    await expect(listOfflineDivergences(db, staff, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listOfflineDivergences(db, customer, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("recusa sem permissão, vazio ou acima do limite", async () => {
    const { unassigned, staff, event, tickets } = await setup();
    const one = [{ payload: qrPayload(tickets[0]), scannedAt: new Date().toISOString(), localResult: "ADMITTED" as const }];
    await expect(syncOfflineCheckins(db, unassigned, event.id, one)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(syncOfflineCheckins(db, staff, event.id, [])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(syncOfflineCheckins(db, staff, event.id, "x")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(syncOfflineCheckins(db, staff, event.id, Array.from({ length: 501 }, () => one[0]))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.ticketCheckin.count()).toBe(0);
  });
});
