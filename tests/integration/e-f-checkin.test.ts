// Fluxos E e F: QR → validação atômica → entrada; leitura repetida → duplicado.
import { beforeEach, describe, expect, it } from "vitest";
import { checkInTicket, checkinHistory } from "@/server/services/checkin";
import { qrPayload } from "@/server/services/tickets";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup() {
  const owner = await makeUser();
  const staff = await makeUser();
  const unassignedStaff = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: staff.id, role: "CHECKIN_STAFF" }, { userId: unassignedStaff.id, role: "CHECKIN_STAFF" }] });
  const event = await makeEvent(org);
  const otherEvent = await makeEvent(org);
  await db.eventStaffAssignment.create({ data: { eventId: event.id, userId: staff.id, assignedById: owner.id } });
  const customer = await makeUser();
  const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id } });
  return { owner, staff, unassignedStaff, event, otherEvent, tickets, customer };
}

describe("E/F — check-in", () => {
  it("admite uma vez e recusa leituras repetidas", async () => {
    const { staff, event, tickets } = await setup();
    const payload = qrPayload(tickets[0]);
    const first = await checkInTicket(db, staff, event.id, payload);
    expect(first.result).toBe("ADMITTED");
    expect(first.counters).toEqual({ admitted: 1, total: 2 });
    const second = await checkInTicket(db, staff, event.id, payload);
    expect(second.result).toBe("DUPLICATE");
    expect(second.ticket?.checkedInAt).toEqual(first.ticket?.checkedInAt);
    expect(second.counters.admitted).toBe(1);
  });

  it("leituras simultâneas do mesmo QR admitem exatamente uma", async () => {
    const { staff, owner, event, tickets } = await setup();
    const payload = qrPayload(tickets[1]);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => checkInTicket(db, i % 2 ? staff : owner, event.id, payload)));
    expect(results.filter((r) => r.result === "ADMITTED")).toHaveLength(1);
    expect(results.filter((r) => r.result === "DUPLICATE")).toHaveLength(7);
    expect(await db.ticketCheckin.count({ where: { ticketId: tickets[1].id } })).toBe(8);
  });

  it("detecta evento errado, ingresso revogado e QR inválido/forjado", async () => {
    const { staff, owner, event, otherEvent, tickets } = await setup();
    expect((await checkInTicket(db, owner, otherEvent.id, qrPayload(tickets[0]))).result).toBe("WRONG_EVENT");
    await db.issuedTicket.update({ where: { id: tickets[0].id }, data: { status: "REVOKED", revocationReason: "ADMIN" } });
    expect((await checkInTicket(db, staff, event.id, qrPayload(tickets[0]))).result).toBe("REVOKED");
    expect((await checkInTicket(db, staff, event.id, "qualquer coisa")).result).toBe("INVALID");
    // Código correto com token adivinhado.
    const forged = qrPayload({ code: tickets[1].code, validationToken: "A".repeat(43) });
    expect((await checkInTicket(db, staff, event.id, forged)).result).toBe("INVALID");
    // Token correto com código de outro ingresso.
    const mixed = qrPayload({ code: tickets[0].code, validationToken: tickets[1].validationToken });
    expect((await checkInTicket(db, staff, event.id, mixed)).result).toBe("INVALID");
  });

  it("equipe só acessa eventos atribuídos; clientes não acessam", async () => {
    const { staff, unassignedStaff, customer, event, otherEvent, tickets } = await setup();
    await expect(checkInTicket(db, unassignedStaff, event.id, qrPayload(tickets[0]))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkInTicket(db, staff, otherEvent.id, qrPayload(tickets[0]))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(checkInTicket(db, customer, event.id, qrPayload(tickets[0]))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.issuedTicket.count({ where: { status: "CHECKED_IN" } })).toBe(0);
  });

  it("histórico: equipe vê só as próprias leituras; organizador vê todas", async () => {
    const { staff, owner, event, tickets } = await setup();
    await checkInTicket(db, staff, event.id, qrPayload(tickets[0]));
    await checkInTicket(db, owner, event.id, qrPayload(tickets[1]));
    expect(await checkinHistory(db, staff, event.id)).toHaveLength(1);
    expect(await checkinHistory(db, owner, event.id)).toHaveLength(2);
  });

  it("recusa check-in em evento cancelado", async () => {
    const { staff, event, tickets } = await setup();
    await db.event.update({ where: { id: event.id }, data: { status: "CANCELLED" } });
    expect((await checkInTicket(db, staff, event.id, qrPayload(tickets[0]))).result).toBe("EVENT_NOT_ACTIVE");
  });
});
