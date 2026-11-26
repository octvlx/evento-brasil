import { beforeEach, describe, expect, it } from "vitest";
import { adapter, db, makeOrg, makeUser, makeEvent, orderInput, resetDb } from "../support/fixtures";
import { createOrder, expireStaleOrders } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { disableSeating, expandSeatGrid, publicSeatMap, setSeatGrid } from "@/server/services/seats";
import { upsertTicketType } from "@/server/services/events";
import { seatOf, SEAT_OF_TICKET } from "@/lib/seat-label";

const later = (min: number) => new Date(Date.now() + min * 60_000);
beforeEach(resetDb);

/** Evento com um tipo de lugar marcado (fileiras A e B, 5 assentos; B5 bloqueado) e um de pista. */
async function seatedEvent() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ name: "Plateia", priceCents: 5000, quantityTotal: 1 }, { name: "Pista", priceCents: 3000, quantityTotal: 50 }] });
  const [plateia, pista] = event.ticketTypes;
  await setSeatGrid(db, owner, plateia.id, { rows: [{ row: "A", seats: 5 }, { row: "B", seats: 5 }], blocked: ["B5"] });
  const seats = new Map((await db.seat.findMany({ where: { ticketTypeId: plateia.id } })).map((s) => [s.label, s.id]));
  return { owner, event, plateia, pista, seat: (label: string) => seats.get(label)! };
}
const order = (user: Awaited<ReturnType<typeof makeUser>>, eventId: string, items: { ticketTypeId: string; quantity: number; seatIds?: string[] }[]) =>
  createOrder(db, user, orderInput(eventId, items), { providerIsSimulated: true });

describe("grade de assentos", () => {
  it("expande fileiras, valida e recusa grade inválida", () => {
    expect(expandSeatGrid({ rows: [{ row: "a", seats: 2 }], blocked: ["A2"] })).toEqual([
      { row: "A", number: 1, label: "A1", blocked: false },
      { row: "A", number: 2, label: "A2", blocked: true },
    ]);
    expect(() => expandSeatGrid({ rows: [{ row: "A", seats: 2 }, { row: "A", seats: 3 }] })).toThrow(/repetida/);
    expect(() => expandSeatGrid({ rows: [{ row: "A", seats: 2 }], blocked: ["C9"] })).toThrow(/não existe/);
    expect(() => expandSeatGrid({ rows: [{ row: "A", seats: 1 }], blocked: ["A1"] })).toThrow(/ao menos um/);
    expect(() => expandSeatGrid({ rows: [{ row: "A-1", seats: 1 }] })).toThrow(/Fileira/);
  });

  it("liga o lugar marcado: estoque = assentos à venda; o formulário não muda o estoque", async () => {
    const { owner, event, plateia } = await seatedEvent();
    expect(await db.ticketType.findUniqueOrThrow({ where: { id: plateia.id } })).toMatchObject({ seated: true, quantityTotal: 9 });
    await upsertTicketType(db, owner, event.id, { id: plateia.id, name: "Plateia", kind: "GENERAL", priceCents: 5000, quantityTotal: 500, minPerOrder: 1, maxPerOrder: 10, requiresAttendeeInfo: false, isHidden: false });
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: plateia.id } })).quantityTotal).toBe(9);
  });

  it("mapa público: livre, ocupado e bloqueado, sem dados de quem comprou", async () => {
    const { event, plateia, seat } = await seatedEvent();
    await order(await makeUser(), event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("A1")] }]);
    const map = await publicSeatMap(db, plateia.id);
    const status = Object.fromEntries(map!.rows.flatMap((r) => r.seats.map((s) => [s.label, s.status])));
    expect(status).toMatchObject({ A1: "TAKEN", A2: "FREE", B5: "BLOCKED" });
    expect(JSON.stringify(map)).not.toMatch(/orderItemId|userId|email/);
    // Reserva vencida (ainda não liberada pelo job) já aparece livre.
    expect((await publicSeatMap(db, plateia.id, later(16)))!.rows[0].seats[0].status).toBe("FREE");
  });
});

describe("compra com lugar marcado", () => {
  it("exige um assento por ingresso, recusa assento bloqueado, de outro tipo ou em tipo sem lugar marcado", async () => {
    const { event, plateia, pista, seat } = await seatedEvent();
    const u = await makeUser();
    await expect(order(u, event.id, [{ ticketTypeId: plateia.id, quantity: 2, seatIds: [seat("A1")] }])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(order(u, event.id, [{ ticketTypeId: plateia.id, quantity: 2, seatIds: [seat("A1"), seat("A1")] }])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(order(u, event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("B5")] }])).rejects.toMatchObject({ code: "SOLD_OUT" });
    await expect(order(u, event.id, [{ ticketTypeId: pista.id, quantity: 1, seatIds: [seat("A1")] }])).rejects.toMatchObject({ code: "VALIDATION" });
    // Falha desfaz tudo: nenhum estoque nem assento preso.
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: plateia.id } })).quantityReserved).toBe(0);
    expect(await db.seat.count({ where: { orderItemId: { not: null } } })).toBe(0);
  });

  it("dois compradores no mesmo assento ao mesmo tempo: só um consegue (sem venda dupla)", async () => {
    const { event, plateia, seat } = await seatedEvent();
    const buyers = await Promise.all(Array.from({ length: 6 }, () => makeUser()));
    const results = await Promise.allSettled(buyers.map((u) => order(u, event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("A3")] }])));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "SOLD_OUT")).toBe(true);
    expect(await db.seat.count({ where: { orderItemId: { not: null } } })).toBe(1);
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: plateia.id } })).quantityReserved).toBe(1);
  });

  it("pago: cada ingresso recebe seu assento; expirado ou cancelado: o assento volta a ficar livre", async () => {
    const { event, plateia, pista, seat } = await seatedEvent();
    const buyer = await makeUser();
    const paid = await order(buyer, event.id, [
      { ticketTypeId: plateia.id, quantity: 2, seatIds: [seat("A2"), seat("A1")] },
      { ticketTypeId: pista.id, quantity: 1 },
    ]);
    const p = await startPayment(db, adapter, buyer, paid.id, "PIX");
    await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"));
    const tickets = await db.issuedTicket.findMany({ where: { orderId: paid.id }, include: { ticketType: true, orderItem: SEAT_OF_TICKET }, orderBy: [{ ticketTypeId: "asc" }, { sequence: "asc" }] });
    const bySeat = tickets.map((t) => [t.ticketType.name, t.sequence, seatOf(t)]);
    expect(bySeat).toEqual(expect.arrayContaining([["Plateia", 1, "A2"], ["Plateia", 2, "A1"], ["Pista", 1, null]]));

    const other = await makeUser();
    const pending = await order(other, event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("A4")] }]);
    expect(await expireStaleOrders(db, later(16))).toBe(1);
    expect((await db.seat.findUniqueOrThrow({ where: { id: seat("A4") } })).orderItemId).toBeNull();
    expect((await db.orderItem.findFirstOrThrow({ where: { orderId: pending.id } })).seatIds).toEqual([seat("A4")]);
    // O assento liberado pode ser comprado por outra pessoa.
    await order(await makeUser(), event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("A4")] }]);
  });

  it("pagamento atrasado: retoma os mesmos assentos se livres; senão reembolsa", async () => {
    const { event, plateia, seat } = await seatedEvent();
    const a = await makeUser();
    const oa = await order(a, event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("A5")] }]);
    const pa = await startPayment(db, adapter, a, oa.id, "PIX");
    await expireStaleOrders(db, later(16));
    expect((await handlePaymentWebhook(db, adapter, await adapter.simulate(pa.providerPaymentId!, "approve"))).body).toBe("late_paid");
    const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: oa.id }, include: { orderItem: SEAT_OF_TICKET } });
    expect(seatOf(ticket)).toBe("A5");

    const b = await makeUser();
    const ob = await order(b, event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("B1")] }]);
    const pb = await startPayment(db, adapter, b, ob.id, "PIX");
    await expireStaleOrders(db, later(16));
    await order(await makeUser(), event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("B1")] }]); // outra pessoa pegou B1
    expect((await handlePaymentWebhook(db, adapter, await adapter.simulate(pb.providerPaymentId!, "approve"))).body).toBe("late_payment_refund");
    expect(await db.issuedTicket.count({ where: { orderId: ob.id } })).toBe(0);
  });
});

describe("edição da grade depois de vendas", () => {
  it("assento ocupado não sai da grade nem é bloqueado; o lugar marcado não pode ser desligado", async () => {
    const { owner, event, plateia, seat } = await seatedEvent();
    await order(await makeUser(), event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("B4")] }]);
    await expect(setSeatGrid(db, owner, plateia.id, { rows: [{ row: "A", seats: 5 }] })).rejects.toThrow(/B4 já foi reservado/);
    await expect(setSeatGrid(db, owner, plateia.id, { rows: [{ row: "A", seats: 5 }, { row: "B", seats: 5 }], blocked: ["B4"] })).rejects.toThrow(/não pode ser bloqueado/);
    await expect(disableSeating(db, owner, plateia.id)).rejects.toThrow(/não pode ser desligado/);
    // Acrescentar fileira e desbloquear assento livre continuam possíveis.
    await setSeatGrid(db, owner, plateia.id, { rows: [{ row: "A", seats: 5 }, { row: "B", seats: 5 }, { row: "C", seats: 2 }] });
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: plateia.id } })).quantityTotal).toBe(12);
  });

  it("tipo com pedidos sem lugar marcado não vira lugar marcado; só quem edita o evento mexe na grade", async () => {
    const { owner, event, pista } = await seatedEvent();
    await order(await makeUser(), event.id, [{ ticketTypeId: pista.id, quantity: 1 }]);
    await expect(setSeatGrid(db, owner, pista.id, { rows: [{ row: "A", seats: 5 }] })).rejects.toThrow(/sem lugar marcado/);
    const stranger = await makeUser();
    await expect(setSeatGrid(db, stranger, pista.id, { rows: [{ row: "A", seats: 5 }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("o banco recusa assento bloqueado ocupado e ocupação incompleta", async () => {
    const { event, plateia, seat } = await seatedEvent();
    const o = await order(await makeUser(), event.id, [{ ticketTypeId: plateia.id, quantity: 1, seatIds: [seat("A1")] }]);
    await expect(db.seat.update({ where: { id: seat("A1") }, data: { blocked: true } })).rejects.toThrow(/Seat_blocked_free/);
    const item = await db.orderItem.findFirstOrThrow({ where: { orderId: o.id } });
    await expect(db.seat.update({ where: { id: seat("A2") }, data: { orderItemId: item.id } })).rejects.toThrow(/Seat_occupancy_complete/);
  });
});
