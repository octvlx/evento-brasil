// Fluxos E e F: QR → validação atômica → entrada; leitura repetida → duplicado.
import { beforeEach, describe, expect, it } from "vitest";
import { cancelEvent } from "@/server/services/cancellation";
import { checkInTicket, checkinHistory } from "@/server/services/checkin";
import { handlePaymentWebhook } from "@/server/services/payments";
import { qrPayload } from "@/server/services/tickets";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

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
    const admitted = await db.ticketCheckin.findMany({ where: { ticketId: tickets[1].id, result: "ADMITTED" } });
    expect(admitted).toHaveLength(1);
    const ticket = await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[1].id } });
    expect(admitted[0].scannedAt).toEqual(ticket.checkedInAt);
  });

  it("transação única: se o registro da leitura falha, o ingresso continua VALID", async () => {
    const { staff, event, tickets } = await setup();
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_falha_checkin() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'falha simulada no registro'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER test_falha_checkin BEFORE INSERT ON "TicketCheckin" FOR EACH ROW EXECUTE FUNCTION test_falha_checkin()`);
    try {
      await expect(checkInTicket(db, staff, event.id, qrPayload(tickets[0]))).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_falha_checkin ON "TicketCheckin"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_falha_checkin()`);
    }
    const ticket = await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } });
    expect(ticket.status).toBe("VALID");
    expect(ticket.checkedInAt).toBeNull();
    expect(await db.ticketCheckin.count()).toBe(0);
    // Sem a falha, a mesma leitura é admitida normalmente.
    expect((await checkInTicket(db, staff, event.id, qrPayload(tickets[0]))).result).toBe("ADMITTED");
  });

  it("cancelamento do evento concorrente com leituras: sem deadlock e estados consistentes", async () => {
    const { owner, staff, event, customer } = await setup();
    const typeId = event.ticketTypes[0].id;
    const orders = [
      (await buyAndPay(customer, event.id, [{ ticketTypeId: typeId, quantity: 10 }])).order,
      (await buyAndPay(customer, event.id, [{ ticketTypeId: typeId, quantity: 10 }])).order,
    ];
    const tickets = await db.issuedTicket.findMany({ where: { orderId: { in: orders.map((o) => o.id) } } });
    expect(tickets).toHaveLength(20);

    const scans = tickets.map((t, i) => checkInTicket(db, i % 2 ? staff : owner, event.id, qrPayload(t)));
    const cancel = cancelEvent(db, adapter, owner, event.id, "Problema com o local");
    const [cancelled, ...scanned] = await Promise.allSettled([cancel, ...scans]);

    expect(cancelled.status).toBe("fulfilled");
    for (const s of scanned) {
      expect(s.status, s.status === "rejected" ? String(s.reason) : "").toBe("fulfilled");
    }
    const results = scanned.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof checkInTicket>>>).value.result);
    for (const [i, t] of tickets.entries()) {
      expect(["ADMITTED", "EVENT_NOT_ACTIVE"]).toContain(results[i]);
      const current = await db.issuedTicket.findUniqueOrThrow({ where: { id: t.id } });
      const admittedRows = await db.ticketCheckin.findMany({ where: { ticketId: t.id, result: "ADMITTED" } });
      if (results[i] === "ADMITTED") {
        expect(admittedRows).toHaveLength(1);
        expect(admittedRows[0].scannedAt).toEqual(current.checkedInAt);
      } else {
        expect(admittedRows).toHaveLength(0);
      }
      // O reembolso automático do cancelamento também revoga ingressos já utilizados.
      if (current.status === "CHECKED_IN") expect(admittedRows).toHaveLength(1);
      else expect(current.status).toBe("REVOKED");
    }
    expect(await db.ticketCheckin.count({ where: { eventId: event.id } })).toBe(20);
  });

  it("chargeback concorrente com leituras: cada ingresso termina admitido uma vez ou revogado", async () => {
    const { staff, owner, event, customer } = await setup();
    const { order, payment } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 10 }]);
    const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id } });
    const webhook = await adapter.simulate(payment.providerPaymentId!, "chargeback");

    const scans = tickets.map((t, i) => checkInTicket(db, i % 2 ? staff : owner, event.id, qrPayload(t)));
    const [charged, ...scanned] = await Promise.allSettled([handlePaymentWebhook(db, adapter, webhook), ...scans]);

    expect(charged.status).toBe("fulfilled");
    for (const s of scanned) {
      expect(s.status, s.status === "rejected" ? String(s.reason) : "").toBe("fulfilled");
    }
    const results = scanned.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof checkInTicket>>>).value.result);
    for (const [i, t] of tickets.entries()) {
      const current = await db.issuedTicket.findUniqueOrThrow({ where: { id: t.id } });
      const admittedRows = await db.ticketCheckin.count({ where: { ticketId: t.id, result: "ADMITTED" } });
      if (results[i] === "ADMITTED") {
        expect(current.status).toBe("CHECKED_IN");
        expect(admittedRows).toBe(1);
      } else {
        expect(results[i]).toBe("REVOKED");
        expect(current.status).toBe("REVOKED");
        expect(admittedRows).toBe(0);
      }
    }
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DISPUTED");
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
