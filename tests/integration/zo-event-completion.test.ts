// Encerramento automático de eventos: o backend reconhece o término pelo relógio
// (mesmo com o status ainda PUBLISHED, sem o job), o job grava COMPLETED de forma
// idempotente, e nada do histórico (pedidos, ingressos, QR, check-ins, razão,
// reembolsos) muda por causa do encerramento.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as maintenance } from "@/app/api/cron/maintenance/route";
import { cancelEvent } from "@/server/services/cancellation";
import { featuredEvents, cityShowcase, eventsInCity, getPublicEvent, listCities, searchEvents, weekendEvents } from "@/server/services/catalog";
import { checkInTicket } from "@/server/services/checkin";
import { createCheckoutDraft } from "@/server/services/checkout-review";
import { archiveEvent, completeEndedEvents, upsertTicketType } from "@/server/services/events";
import { createOrder, expireStaleOrders } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { organizerDashboard } from "@/server/services/reports";
import { suggestSearch } from "@/server/services/search";
import { rankPublicEvents } from "@/server/services/search-ranking";
import { qrPayload } from "@/server/services/tickets";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeVerifiedUser as makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
});

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

/**
 * Leva o evento para o passado sem passar pelo job: o status continua PUBLISHED.
 * As vendas ficam (de propósito) configuradas até depois do término, para provar
 * que o bloqueio vem do horário de término e não do fim das vendas.
 */
async function endEvent(eventId: string, endedAgoMs: number) {
  return db.event.update({
    where: { id: eventId },
    data: { startsAt: ago(endedAgoMs + 4 * HOUR), endsAt: ago(endedAgoMs), salesStartAt: ago(30 * 24 * HOUR), salesEndAt: ahead(24 * HOUR) },
  });
}

async function paidEvent(opts: { title?: string; quantity?: number } = {}) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ priceCents: 8000, quantityTotal: 50 }] });
  await db.event.update({ where: { id: event.id }, data: { title: opts.title ?? "Festival Zeta do Encerramento", isFeatured: true } });
  const buyer = await makeUser();
  const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: opts.quantity ?? 2 }]);
  return { owner, org, event, buyer, order, payment };
}

/** Tudo o que o encerramento precisa preservar, para comparar antes e depois. */
async function history(eventId: string) {
  const [tickets, checkins, orders, payments, ledger, refunds, items] = await Promise.all([
    db.issuedTicket.findMany({ where: { eventId }, orderBy: { id: "asc" }, select: { id: true, status: true, code: true, validationToken: true, checkedInAt: true, revokedAt: true, holderName: true } }),
    db.ticketCheckin.findMany({ where: { eventId }, orderBy: { id: "asc" } }),
    db.order.findMany({ where: { eventId }, orderBy: { id: "asc" }, select: { id: true, status: true, totalCents: true, serviceFeeCents: true, paidAt: true, buyerEmail: true } }),
    db.payment.findMany({ where: { order: { eventId } }, orderBy: { id: "asc" }, select: { id: true, status: true, amountCents: true, paidAt: true } }),
    db.financialLedgerEntry.findMany({ where: { order: { eventId } }, orderBy: { id: "asc" } }),
    db.refund.findMany({ where: { order: { eventId } }, orderBy: { id: "asc" } }),
    db.orderItem.findMany({ where: { order: { eventId } }, orderBy: { id: "asc" } }),
  ]);
  return { tickets, checkins, orders, payments, ledger, refunds, items };
}

const cron = (secret = "test-only-cron") => maintenance(new Request("http://localhost/api/cron/maintenance", { method: "POST", headers: { "x-cron-secret": secret } }));

describe("reconhecimento em tempo real (sem depender do job)", () => {
  it("evento vencido com status ainda PUBLISHED: fora de toda listagem de eventos futuros", async () => {
    const { event } = await paidEvent();
    const city = await db.city.findUniqueOrThrow({ where: { id: event.cityId! } });
    // Ainda ativo: aparece.
    expect((await searchEvents(db, {})).events.map((e) => e.id)).toContain(event.id);
    expect((await featuredEvents(db)).map((e) => e.id)).toContain(event.id);

    await endEvent(event.id, 1000);
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("PUBLISHED");
    expect((await searchEvents(db, {})).events).toHaveLength(0);
    expect((await searchEvents(db, { q: "Festival Zeta" })).events).toHaveLength(0);
    expect(await rankPublicEvents(db, "zeta", {})).toEqual([]);
    expect(await featuredEvents(db)).toEqual([]);
    expect(await eventsInCity(db, city.slug)).toEqual([]);
    expect(await weekendEvents(db)).toEqual([]);
    expect(await cityShowcase(db, city.slug)).toMatchObject({ total: 0, featured: [], shelves: [] });
    expect((await listCities(db)).map((c) => c.id)).not.toContain(city.id);
    const groups = await suggestSearch(db, "festival zeta");
    expect(groups.flatMap((g) => g.items).filter((i) => i.kind === "event")).toEqual([]);
  });

  it("página individual continua acessível, marcada como encerrada e sem venda", async () => {
    const { event } = await paidEvent();
    expect(await getPublicEvent(db, event.slug)).toMatchObject({ ended: false });
    await endEvent(event.id, 3 * HOUR);
    expect(await getPublicEvent(db, event.slug)).toMatchObject({ ended: true, availability: "CLOSED" });
    await completeEndedEvents(db);
    expect(await getPublicEvent(db, event.slug)).toMatchObject({ ended: true, availability: "CLOSED" });
    // Cancelado ou arquivado não é página pública.
    await db.event.update({ where: { id: event.id }, data: { status: "ARCHIVED" } });
    expect(await getPublicEvent(db, event.slug)).toBeNull();
  });

  it("tentativa de compra após o término: sem carrinho, sem reserva, sem pedido", async () => {
    const owner = await makeUser();
    const event = await makeEvent(await makeOrg(owner));
    await endEvent(event.id, 1000);
    const buyer = await makeUser();
    const items = [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }];
    await expect(createCheckoutDraft(db, orderInput(event.id, items), buyer)).rejects.toMatchObject({ code: "SALES_CLOSED" });
    await expect(createOrder(db, buyer, orderInput(event.id, items), { providerIsSimulated: true })).rejects.toMatchObject({ code: "SALES_CLOSED" });
    expect(await db.order.count({ where: { eventId: event.id } })).toBe(0);
    expect(await db.checkoutDraft.count({ where: { eventId: event.id } })).toBe(0);
    expect(await db.ticketInventoryReservation.count({ where: { ticketType: { eventId: event.id } } })).toBe(0);
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: event.ticketTypes[0].id } })).quantityReserved).toBe(0);
  });

  it("pedido reservado antes do término não gera nova cobrança depois dele", async () => {
    const owner = await makeUser();
    const event = await makeEvent(await makeOrg(owner));
    const buyer = await makeUser();
    const order = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await endEvent(event.id, 1000);
    await expect(startPayment(db, adapter, buyer, order.id, "PIX")).rejects.toMatchObject({ code: "SALES_CLOSED" });
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe("pagamento confirmado após o encerramento", () => {
  it("pagamento iniciado antes do término e confirmado depois: pedido pago e ingressos emitidos", async () => {
    const owner = await makeUser();
    const event = await makeEvent(await makeOrg(owner));
    const buyer = await makeUser();
    const order = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    const p = await startPayment(db, adapter, buyer, order.id, "PIX");
    await endEvent(event.id, 1000);
    await completeEndedEvents(db);
    const res = await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"));
    expect(res.body).toBe("paid");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await db.issuedTicket.count({ where: { orderId: order.id, status: "VALID" } })).toBe(2);
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("reserva já expirada e evento encerrado: reembolso do pagamento tardio, com ou sem o job ter rodado", async () => {
    for (const runJob of [false, true]) {
      const owner = await makeUser();
      const event = await makeEvent(await makeOrg(owner));
      const buyer = await makeUser();
      const order = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
      const p = await startPayment(db, adapter, buyer, order.id, "PIX");
      await expireStaleOrders(db, ahead(16 * 60_000));
      await endEvent(event.id, 1000);
      if (runJob) await completeEndedEvents(db);
      expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(runJob ? "COMPLETED" : "PUBLISHED");
      // O dinheiro nunca é ignorado: vira pedido em reembolso, sem ingresso para um evento que já passou.
      const res = await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"));
      expect(res.body).toBe("late_payment_refund");
      expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(0);
      expect(await db.refund.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({ reason: "LATE_PAYMENT_NO_INVENTORY", amountCents: order.totalCents });
    }
  });
});

describe("job de encerramento (cron)", () => {
  it("encerra só os publicados vencidos; preserva cancelados, rascunhos e futuros; repetir não tem efeito", async () => {
    const org = await makeOrg(await makeUser());
    const [ended, endedNow, future, cancelled] = [await makeEvent(org), await makeEvent(org), await makeEvent(org), await makeEvent(org)];
    const draft = await makeEvent(org, { status: "DRAFT" });
    await endEvent(ended.id, 5 * HOUR);
    await endEvent(cancelled.id, 5 * HOUR);
    await endEvent(draft.id, 5 * HOUR);
    await db.event.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
    const now = new Date();
    await db.event.update({ where: { id: endedNow.id }, data: { startsAt: new Date(now.getTime() - HOUR), endsAt: now } });

    expect(await completeEndedEvents(db, now)).toBe(2);
    const status = async (id: string) => (await db.event.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(ended.id)).toBe("COMPLETED");
    expect(await status(endedNow.id)).toBe("COMPLETED"); // termina exatamente agora
    expect(await status(future.id)).toBe("PUBLISHED");
    expect(await status(cancelled.id)).toBe("CANCELLED");
    expect(await status(draft.id)).toBe("DRAFT");
    // Execução repetida e execuções simultâneas: nada a mais.
    expect(await completeEndedEvents(db, now)).toBe(0);
    expect(await Promise.all([completeEndedEvents(db), completeEndedEvents(db), completeEndedEvents(db)])).toEqual([0, 0, 0]);
  });

  it("endpoint: exige o segredo, encerra e é idempotente", async () => {
    const { event } = await paidEvent();
    await endEvent(event.id, HOUR);
    expect((await cron("segredo-errado")).status).toBe(403);
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("PUBLISHED");
    const first = await cron();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ completedEvents: 1, failedSteps: [] });
    expect(await (await cron()).json()).toMatchObject({ completedEvents: 0, failedSteps: [] });
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("COMPLETED");
  });

  it("preserva ingressos, QR Codes, check-ins, pedidos, pagamentos, razão e reembolsos", async () => {
    const { owner, event, order } = await paidEvent({ quantity: 3 });
    const [first] = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
    expect((await checkInTicket(db, owner, event.id, qrPayload(first))).result).toBe("ADMITTED");
    await endEvent(event.id, 2 * HOUR);
    const before = await history(event.id);
    expect(before.ledger.length).toBeGreaterThan(0);

    expect(await completeEndedEvents(db)).toBe(1);
    await completeEndedEvents(db);
    expect(await history(event.id)).toEqual(before);
    expect(before.tickets.map((t) => t.status).sort()).toEqual(["CHECKED_IN", "VALID", "VALID"]);
    expect(before.orders[0].status).toBe("PAID");
  });
});

describe("portaria depois do término (fechamento operacional)", () => {
  it("QR continua válido nas 12 h após o término, com o job atrasado ou já executado", async () => {
    for (const runJob of [false, true]) {
      const { owner, event, order } = await paidEvent({ title: `Show ${runJob}` });
      const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
      await endEvent(event.id, 2 * HOUR);
      if (runJob) await completeEndedEvents(db);
      expect((await checkInTicket(db, owner, event.id, qrPayload(tickets[0]))).result).toBe("ADMITTED");
      expect((await checkInTicket(db, owner, event.id, qrPayload(tickets[0]))).result).toBe("DUPLICATE");
    }
  });

  it("depois de 12 h a entrada fecha mesmo com o status ainda PUBLISHED; o ingresso segue VALID", async () => {
    const { owner, event, order } = await paidEvent();
    const [ticket] = await db.issuedTicket.findMany({ where: { orderId: order.id } });
    await endEvent(event.id, 13 * HOUR);
    expect((await checkInTicket(db, owner, event.id, qrPayload(ticket))).result).toBe("EVENT_NOT_ACTIVE");
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("VALID");
  });
});

describe("área do organizador", () => {
  it("encerrado continua no histórico e nos relatórios, com status Encerrado antes do job", async () => {
    const { owner, org, event } = await paidEvent();
    await endEvent(event.id, HOUR);
    const dash = await organizerDashboard(db, owner, org.id);
    expect(dash.upcomingEvents.map((e) => e.id)).not.toContain(event.id);
    expect(dash.pastCount).toBe(1);
    expect(dash.eventPerformance).toEqual([expect.objectContaining({ id: event.id, status: "COMPLETED", sold: 2, grossCents: expect.any(Number) })]);
    expect(dash.eventPerformance![0].grossCents).toBeGreaterThan(0);
  });

  it("encerrado (pelo relógio) não é editado nem cancelado; pode ser arquivado", async () => {
    const { owner, event, order } = await paidEvent();
    await endEvent(event.id, HOUR);
    const tt = event.ticketTypes[0];
    await expect(upsertTicketType(db, owner, event.id, { id: tt.id, name: "Novo nome", kind: "GENERAL", priceCents: 9000, quantityTotal: 50, minPerOrder: 1, maxPerOrder: 10, requiresAttendeeInfo: false, isHidden: false })).rejects.toMatchObject({ code: "INVALID_STATE" });
    // Cancelar reembolsaria todos e revogaria os ingressos de um evento que já aconteceu.
    await expect(cancelEvent(db, adapter, owner, event.id, "Motivo qualquer")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await db.issuedTicket.count({ where: { orderId: order.id, status: "VALID" } })).toBe(2);
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(0);
    await archiveEvent(db, owner, event.id);
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("ARCHIVED");
  });
});
