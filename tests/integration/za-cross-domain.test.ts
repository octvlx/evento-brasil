// V1 (Fase 4) — testes cruzados entre domínios: transferência de titularidade
// (check-in) × check-in × reembolso × pedido de cancelamento (admin) × alteração
// relevante (organizador) × limite por conta × cancelamento do evento × manutenção.
// Cada teste termina com `checkFinancialInvariants() == []` (afterEach).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCancellationRequest, decideCancellationRequest } from "@/server/services/cancellation-requests";
import { cancelEvent } from "@/server/services/cancellation";
import { checkInTicket } from "@/server/services/checkin";
import { extendEventChangeWindow } from "@/server/services/event-changes";
import { completeEndedEvents, createEvent, updateEvent } from "@/server/services/events";
import { cancelPendingOrder, createOrder, expireStaleOrders, ticketsHeldByAccount } from "@/server/services/orders";
import { checkFinancialInvariants, reconcilePayments } from "@/server/services/reconciliation";
import { requestCustomerRefund } from "@/server/services/refunds";
import { handlePaymentWebhook } from "@/server/services/payments";
import { qrPayload } from "@/server/services/tickets";
import { acceptTransfer, expireTicketTransfers, requestTransfer } from "@/server/services/transfers";
import { adapter, buy, buyAndPay, db, makeCategory, makeCity, makeEvent, makeOrg, makeVerifiedUser as makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
});

const DAY = 86_400_000;
const MIN = 60_000;
const later = (ms: number) => new Date(Date.now() + ms);

type User = Awaited<ReturnType<typeof makeUser>>;

function transfer(from: User, ticketId: string, to: User) {
  return requestTransfer(db, from, ticketId, { toEmail: to.email, toName: `Nome ${to.name}` });
}

async function transferAccepted(from: User, ticketId: string, to: User) {
  const { token } = await transfer(from, ticketId, to);
  await acceptTransfer(db, to, token);
  return db.issuedTicket.findUniqueOrThrow({ where: { id: ticketId } });
}

const ticketsOf = (orderId: string) => db.issuedTicket.findMany({ where: { orderId }, orderBy: { sequence: "asc" } });

/** Mesmos passos e ordem de `POST /api/cron/maintenance`, com relógio controlável. */
async function runMaintenance(now = new Date()) {
  const expiredOrders = await expireStaleOrders(db, now);
  const completedEvents = await completeEndedEvents(db);
  const expiredTransfers = await expireTicketTransfers(db, now);
  const reconciliation = await reconcilePayments(db, adapter, now);
  const violations = await checkFinancialInvariants(db);
  return { expiredOrders, completedEvents, expiredTransfers, reconciliation, violations };
}

async function paidSetup(opts: { quantity?: number; refundWindowDays?: number; maxTicketsPerAccount?: number; startsInDays?: number } = {}) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { startsInDays: opts.startsInDays ?? 30 });
  if (opts.refundWindowDays !== undefined || opts.maxTicketsPerAccount !== undefined) {
    await db.event.update({ where: { id: event.id }, data: { refundWindowDays: opts.refundWindowDays, maxTicketsPerAccount: opts.maxTicketsPerAccount } });
  }
  const buyer = await makeUser();
  const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: opts.quantity ?? 2 }]);
  return { owner, org, event, buyer, order: await db.order.findUniqueOrThrow({ where: { id: order.id } }), payment, tickets: await ticketsOf(order.id) };
}

/** Um único reembolso não rejeitado, integral, para o pagamento de quem pagou. */
async function expectSingleRefundToPayer(orderId: string, paymentId: string, totalCents: number) {
  const refunds = await db.refund.findMany({ where: { orderId, status: { not: "REJECTED" } } });
  expect(refunds).toHaveLength(1);
  expect(refunds[0]).toMatchObject({ status: "SUCCEEDED", paymentId, amountCents: totalCents });
  expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("REFUNDED");
  expect((await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("REFUNDED");
}

describe("V1.1 — aceite de transferência × check-in", () => {
  it("aceite disputando com leituras do QR antigo: no máximo uma entrada, nunca pelo QR antigo depois da troca", async () => {
    const { owner, event, buyer, tickets } = await paidSetup({ quantity: 6 });
    const recipients = await Promise.all(tickets.map(() => makeUser()));
    for (let i = 0; i < tickets.length; i++) {
      const old = tickets[i];
      const { token } = await transfer(buyer, old.id, recipients[i]);
      const [accept, ...scans] = await Promise.allSettled([
        acceptTransfer(db, recipients[i], token),
        ...Array.from({ length: 4 }, () => checkInTicket(db, owner, event.id, qrPayload(old))),
      ]);
      const admittedOld = scans.filter((s) => s.status === "fulfilled" && s.value.result === "ADMITTED").length;
      const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: old.id } });
      if (accept.status === "fulfilled") {
        // O aceite venceu: o QR antigo não admitiu e o ingresso tem novo token.
        expect(admittedOld).toBe(0);
        expect(after).toMatchObject({ status: "VALID", holderUserId: recipients[i].id });
        expect(after.validationToken).not.toBe(old.validationToken);
        // Depois da troca: QR antigo e novo ao mesmo tempo → só o novo entra, uma vez.
        const race = await Promise.all([
          ...Array.from({ length: 3 }, () => checkInTicket(db, owner, event.id, qrPayload(old))),
          ...Array.from({ length: 3 }, () => checkInTicket(db, owner, event.id, qrPayload(after))),
        ]);
        expect(race.slice(0, 3).every((r) => r.result === "INVALID")).toBe(true);
        expect(race.slice(3).filter((r) => r.result === "ADMITTED")).toHaveLength(1);
        expect(race.slice(3).filter((r) => r.result === "DUPLICATE")).toHaveLength(2);
      } else {
        // A leitura venceu: entrou uma vez com o QR antigo e o aceite foi recusado.
        expect(accept.reason).toMatchObject({ code: "INVALID_STATE" });
        expect(admittedOld).toBe(1);
        expect(after).toMatchObject({ status: "CHECKED_IN", holderUserId: buyer.id, validationToken: old.validationToken });
        expect((await db.ticketTransfer.findFirstOrThrow({ where: { ticketId: old.id } })).status).toBe("PENDING");
      }
      expect(await db.ticketCheckin.count({ where: { ticketId: old.id, result: "ADMITTED" } })).toBe(1);
    }
  });

  it("QR antigo lido depois do aceite não entra nem depois de o novo titular entrar", async () => {
    const { owner, event, buyer, tickets } = await paidSetup({ quantity: 1 });
    const recipient = await makeUser();
    const moved = await transferAccepted(buyer, tickets[0].id, recipient);
    expect((await checkInTicket(db, owner, event.id, qrPayload(tickets[0]))).result).toBe("INVALID");
    expect((await checkInTicket(db, owner, event.id, qrPayload(moved))).result).toBe("ADMITTED");
    expect((await checkInTicket(db, owner, event.id, qrPayload(tickets[0]))).result).toBe("INVALID");
    // Ingresso usado não é reembolsável pelo comprador, mesmo transferido.
    await expect(requestCustomerRefund(db, adapter, buyer, tickets[0].orderId)).rejects.toThrow("Há ingressos já utilizados neste pedido.");
  });
});

describe("V1.2 — aceite × pedido de reembolso × aprovação do pedido de cancelamento", () => {
  it("disputa entre reembolso do comprador e aprovação do admin, com ingresso transferido: um único reembolso, ao pagador", async () => {
    for (let round = 0; round < 4; round++) {
      await resetDb();
      const { buyer, order, payment, tickets, owner, event } = await paidSetup();
      const recipient = await makeUser();
      const admin = await makeUser({ admin: true });
      const moved = await transferAccepted(buyer, tickets[0].id, recipient);
      const request = await createCancellationRequest(db, buyer, order.id, "Não poderei ir ao evento.");

      const [byBuyer, byAdmin, byRecipient] = await Promise.allSettled([
        requestCustomerRefund(db, adapter, buyer, order.id),
        decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE" }),
        requestCustomerRefund(db, adapter, recipient, order.id),
      ]);
      // O destinatário nunca pede reembolso: o pedido não é dele (D7).
      expect(byRecipient.status === "rejected" && (byRecipient.reason as { code?: string }).code).toBe("FORBIDDEN");
      expect(byAdmin.status).toBe("fulfilled");
      if (byAdmin.status === "fulfilled") expect(["REFUND_OPENED", "REFUND_ALREADY_EXISTS"]).toContain(byAdmin.value.outcome);
      if (byBuyer.status === "rejected") expect(byBuyer.reason).toMatchObject({ code: "INVALID_STATE" });

      await expectSingleRefundToPayer(order.id, payment.id, order.totalCents);
      // Nenhum ingresso válido sobra: o QR do destinatário não entra.
      expect((await ticketsOf(order.id)).every((t) => t.status === "REVOKED")).toBe(true);
      expect((await checkInTicket(db, owner, event.id, qrPayload(moved))).result).toBe("REVOKED");
      expect(await ticketsHeldByAccount(db, recipient.id, event.id)).toBe(0);
      expect(await ticketsHeldByAccount(db, buyer.id, event.id)).toBe(0);
      // Nada foi devolvido a outro pagamento.
      expect(await db.refund.count({ where: { paymentId: { not: payment.id } } })).toBe(0);
      // Segunda aprovação/novo pedido: nada de reembolso em dobro.
      await expect(requestCustomerRefund(db, adapter, buyer, order.id)).rejects.toThrow();
      expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
    }
  });

  it("aceite disputando com o reembolso: o ingresso termina revogado, a transferência não fica pendente", async () => {
    for (let round = 0; round < 4; round++) {
      await resetDb();
      const { buyer, order, payment, tickets, owner, event } = await paidSetup({ quantity: 1 });
      const recipient = await makeUser();
      const { token, transferId } = await transfer(buyer, tickets[0].id, recipient);
      const [accept, refund] = await Promise.allSettled([acceptTransfer(db, recipient, token), requestCustomerRefund(db, adapter, buyer, order.id)]);
      expect(refund.status).toBe("fulfilled");
      if (accept.status === "rejected") expect(accept.reason).toMatchObject({ code: "INVALID_STATE" });

      await expectSingleRefundToPayer(order.id, payment.id, order.totalCents);
      const t = await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } });
      expect(t.status).toBe("REVOKED");
      expect((await checkInTicket(db, owner, event.id, qrPayload(t))).result).toBe("REVOKED");
      expect((await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } })).status).not.toBe("PENDING");
    }
  });

  it("transferência pendente é encerrada pelo reembolso e o link deixa de valer", async () => {
    const { buyer, order, tickets } = await paidSetup({ quantity: 2 });
    const recipient = await makeUser();
    const { token, transferId } = await transfer(buyer, tickets[1].id, recipient);
    await requestCustomerRefund(db, adapter, buyer, order.id);
    const row = await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(row).toMatchObject({ status: "CANCELLED", decidedById: null });
    expect(row.decidedAt).not.toBeNull();
    expect(row.decisionReason).toMatch(/reembols/i);
    await expect(acceptTransfer(db, recipient, token)).rejects.toThrow("Esta transferência não está mais disponível.");
  });
  it("chargeback também encerra a transferência pendente; o QR já transferido deixa de entrar", async () => {
    const { owner, event, buyer, order, payment, tickets } = await paidSetup({ quantity: 2 });
    const recipient = await makeUser();
    const moved = await transferAccepted(buyer, tickets[0].id, recipient);
    const { transferId } = await transfer(buyer, tickets[1].id, recipient);
    await handlePaymentWebhook(db, adapter, await adapter.simulate(payment.providerPaymentId!, "chargeback"));
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DISPUTED");
    expect((await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } })).status).toBe("CANCELLED");
    expect((await checkInTicket(db, owner, event.id, qrPayload(moved))).result).toBe("REVOKED");
    expect(await db.refund.count()).toBe(0);
  });
});

describe("V1.3 — janela da alteração relevante com ingressos transferidos", () => {
  /** Evento pelo serviço do organizador, alteração relevante por `updateEvent`. */
  async function changedEvent() {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const [city, category] = await Promise.all([makeCity(), makeCategory()]);
    const local = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 16);
    const at = (days: number) => {
      const s = later(days * DAY);
      return { startsAtLocal: local(s), endsAtLocal: local(new Date(s.getTime() + 4 * 3_600_000)) };
    };
    const input = {
      title: "Show transferido",
      description: "Descrição de teste com mais de vinte caracteres.",
      categoryId: category.id,
      locationType: "VENUE" as const,
      newVenue: { name: "Casa de Shows", addressLine: "Rua A, 10", district: "Centro", cityId: city.id, postalCode: "01001-000" },
      timezone: "America/Sao_Paulo" as const,
      ...at(20),
      salesStartLocal: local(later(-DAY)),
      salesEndLocal: local(later(19 * DAY)),
      ageRestriction: 0,
      capacity: 100,
      refundPolicy: "Reembolso conforme os prazos abaixo.",
      // Fora da janela da alteração, a política normal recusa qualquer reembolso.
      refundWindowDays: 0,
    };
    const event = await createEvent(db, owner, org.id, input);
    const tt = await db.ticketType.create({ data: { eventId: event.id, name: "Inteira", kind: "GENERAL", priceCents: 5000, quantityTotal: 50 } });
    await db.event.update({ where: { id: event.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    const buyer = await makeUser();
    const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: tt.id, quantity: 2 }]);
    const tickets = await ticketsOf(order.id);
    const recipient = await makeUser();
    const moved = await transferAccepted(buyer, tickets[0].id, recipient);
    // Novo início distante: o prazo é o padrão da alteração (não o início) e cabe prorrogação.
    await updateEvent(db, owner, event.id, { ...input, ...at(60), changeReason: "Adiamento por questões técnicas do local." });
    const change = await db.eventChange.findFirstOrThrow({ where: { eventId: event.id, extendsChangeId: null } });
    return { owner, event, buyer, recipient, moved, order: await db.order.findUniqueOrThrow({ where: { id: order.id } }), payment, change };
  }

  it("reembolso integral do pedido com ingresso transferido, no último instante da janela", async () => {
    const { owner, event, buyer, recipient, moved, order, payment, change } = await changedEvent();
    expect(change.refundUntil).not.toBeNull();
    // O destinatário não pede reembolso nem cancelamento do pedido de outra pessoa.
    await expect(requestCustomerRefund(db, adapter, recipient, order.id, change.refundUntil!)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createCancellationRequest(db, recipient, order.id, "Quero cancelar este ingresso.")).rejects.toMatchObject({ code: "FORBIDDEN" });

    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, change.refundUntil!);
    expect(refund).toMatchObject({ status: "SUCCEEDED", reason: "EVENT_CHANGED", eventChangeId: change.id, amountCents: order.totalCents, paymentId: payment.id });
    await expectSingleRefundToPayer(order.id, payment.id, order.totalCents);
    expect((await checkInTicket(db, owner, event.id, qrPayload(moved))).result).toBe("REVOKED");
  });

  it("um milissegundo depois do prazo vale a política normal; a prorrogação reabre a janela", async () => {
    const { owner, buyer, order, payment, change } = await changedEvent();
    const justAfter = new Date(change.refundUntil!.getTime() + 1);
    await expect(requestCustomerRefund(db, adapter, buyer, order.id, justAfter)).rejects.toThrow("O prazo de 0 dias após a compra terminou.");

    const extension = await extendEventChangeWindow(db, owner, change.id, { refundUntil: new Date(change.refundUntil!.getTime() + 2 * DAY), reason: "Mais prazo para quem não conseguiu pedir." });
    expect(extension.extendsChangeId).toBe(change.id);
    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, justAfter);
    expect(refund).toMatchObject({ status: "SUCCEEDED", reason: "EVENT_CHANGED", eventChangeId: change.id, paymentId: payment.id });
    await expectSingleRefundToPayer(order.id, payment.id, order.totalCents);
  });

  it("transferência feita depois da alteração não muda o direito do pagador", async () => {
    const { buyer, order, payment, change, event } = await changedEvent();
    const [, second] = await ticketsOf(order.id);
    const other = await makeUser();
    await transferAccepted(buyer, second.id, other);
    expect(await ticketsHeldByAccount(db, buyer.id, event.id)).toBe(0);
    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, new Date(change.refundUntil!.getTime() - MIN));
    expect(refund).toMatchObject({ reason: "EVENT_CHANGED", paymentId: payment.id });
    expect(await ticketsHeldByAccount(db, other.id, event.id)).toBe(0);
  });
});

describe("V1.4 — limite por conta com transferências, cupom e pedidos pendentes", () => {
  it("transferências de entrada e saída, pedido pendente com cupom e liberação", async () => {
    const { owner, org, event, buyer: a, tickets } = await paidSetup({ quantity: 2, maxTicketsPerAccount: 3 });
    const b = await makeUser();
    const tt = event.ticketTypes[0].id;
    const coupon = await db.coupon.create({ data: { organizationId: org.id, code: "AMIGO10", discountType: "PERCENT", percentBps: 1000, createdById: owner.id } });

    await transferAccepted(a, tickets[0].id, b);
    expect([await ticketsHeldByAccount(db, a.id, event.id), await ticketsHeldByAccount(db, b.id, event.id)]).toEqual([1, 1]);

    // B reserva 2 com cupom: chega ao limite (1 em mãos + 2 pendentes).
    const pending = await createOrder(db, b, orderInput(event.id, [{ ticketTypeId: tt, quantity: 2 }], { couponCode: "AMIGO10" }), { providerIsSimulated: true });
    expect(pending.couponId).toBe(coupon.id);
    expect(await ticketsHeldByAccount(db, b.id, event.id)).toBe(3);
    const { token } = await transfer(a, tickets[1].id, b);
    await expect(acceptTransfer(db, b, token)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[1].id } })).holderUserId).toBe(a.id);

    // Cancelado o pendente, a reserva do cupom volta e o mesmo convite pode ser aceito.
    await cancelPendingOrder(db, b, pending.id);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).timesReserved).toBe(0);
    await acceptTransfer(db, b, token);
    expect([await ticketsHeldByAccount(db, a.id, event.id), await ticketsHeldByAccount(db, b.id, event.id)]).toEqual([0, 2]);

    // A, sem ingressos agora, volta a poder comprar até o limite; B só mais 1.
    await expect(buy(b, event.id, [{ ticketTypeId: tt, quantity: 2 }])).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await buy(a, event.id, [{ ticketTypeId: tt, quantity: 3 }]);
    // Reserva vencida e ainda não liberada não conta; a manutenção libera.
    expect(await ticketsHeldByAccount(db, a.id, event.id, later(20 * MIN))).toBe(0);
    const report = await runMaintenance(later(20 * MIN));
    expect(report.expiredOrders).toBe(1);
    expect(report.violations).toEqual([]);
    expect(await ticketsHeldByAccount(db, a.id, event.id)).toBe(0);
  });

  it("pedidos e aceites simultâneos para a mesma conta não passam do limite", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    // Gratuito: cada pedido é emitido na hora (não substitui o anterior), e o pedido é PAID.
    const event = await makeEvent(org, { tickets: [{ priceCents: 0, quantityTotal: 100 }] });
    await db.event.update({ where: { id: event.id }, data: { maxTicketsPerAccount: 4 } });
    const tt = event.ticketTypes[0].id;
    const givers = await Promise.all([makeUser(), makeUser()]);
    const b = await makeUser();
    const tokens: string[] = [];
    for (const g of givers) {
      const order = await buy(g, event.id, [{ ticketTypeId: tt, quantity: 3 }]);
      for (const t of await ticketsOf(order.id)) tokens.push((await transfer(g, t.id, b)).token);
    }
    expect(tokens).toHaveLength(6);

    const results = await Promise.allSettled([
      ...tokens.map((tk) => acceptTransfer(db, b, tk)),
      ...Array.from({ length: 6 }, () => createOrder(db, b, orderInput(event.id, [{ ticketTypeId: tt, quantity: 1 }], { idempotencyKey: randomUUID() }), { providerIsSimulated: true })),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(4);
    expect(rejected.every((r) => (r.reason as { code?: string }).code === "LIMIT_EXCEEDED")).toBe(true);
    expect(await ticketsHeldByAccount(db, b.id, event.id)).toBe(4);
    expect(await db.issuedTicket.count({ where: { eventId: event.id, holderUserId: b.id, status: "VALID" } })).toBe(4);
    // Quem deu e não teve aceite continua com o ingresso; nenhum some.
    expect(await db.issuedTicket.count({ where: { eventId: event.id, status: "VALID" } })).toBe(6 + results.slice(6).filter((r) => r.status === "fulfilled").length);
  });
  it("aceite com relógio injetado ignora reserva vencida não liberada", async () => {
    const { event, buyer: a, tickets } = await paidSetup({ quantity: 2, maxTicketsPerAccount: 3 });
    const b = await makeUser();
    await transferAccepted(a, tickets[0].id, b);
    await buy(b, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    const { token } = await transfer(a, tickets[1].id, b);
    const at = later(20 * MIN);
    expect(await ticketsHeldByAccount(db, b.id, event.id, at)).toBe(1);
    await acceptTransfer(db, b, token, undefined, at);
    expect(await ticketsHeldByAccount(db, b.id, event.id, at)).toBe(2);
    await runMaintenance(at);
  });
});

describe("V1.5 — cancelamento do evento com transferências pendentes", () => {
  it("encerra as pendentes, revoga tudo e devolve o dinheiro a quem pagou", async () => {
    const { owner, event, buyer, order, payment, tickets } = await paidSetup({ quantity: 3 });
    const [r1, r2] = await Promise.all([makeUser(), makeUser()]);
    const moved = await transferAccepted(buyer, tickets[0].id, r1);
    const { token, transferId } = await transfer(buyer, tickets[1].id, r2);
    // Outro comprador com pedido ainda não pago (reserva ativa).
    const other = await makeUser();
    const pending = await buy(other, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);

    const res = await cancelEvent(db, adapter, owner, event.id, "Problema estrutural no local.");
    expect(res.pendingReleased).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("CANCELLED");
    const row = await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(row.status).toBe("CANCELLED");
    expect(row.decisionReason).toMatch(/cancelad/i);
    expect(await db.ticketTransfer.count({ where: { eventId: event.id, status: "PENDING" } })).toBe(0);
    await expect(acceptTransfer(db, r2, token)).rejects.toMatchObject({ code: "INVALID_STATE" });

    const refund = await db.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(refund).toMatchObject({ reason: "EVENT_CANCELLED", paymentId: payment.id, amountCents: order.totalCents, requestedById: owner.id });
    await expectSingleRefundToPayer(order.id, payment.id, order.totalCents);
    expect((await ticketsOf(order.id)).every((t) => t.status === "REVOKED" && t.revocationReason === "EVENT_CANCELLED")).toBe(true);
    expect((await checkInTicket(db, owner, event.id, qrPayload(moved))).result).toBe("EVENT_NOT_ACTIVE");
    expect(await ticketsHeldByAccount(db, r1.id, event.id)).toBe(0);
  });

  it("cancelamento disputando com o aceite: nada fica válido nem pendente; um reembolso por pedido", async () => {
    for (let round = 0; round < 4; round++) {
      await resetDb();
      const { owner, event, buyer, order, payment, tickets } = await paidSetup({ quantity: 2 });
      const recipient = await makeUser();
      const { token } = await transfer(buyer, tickets[0].id, recipient);
      const [accept, cancel] = await Promise.allSettled([acceptTransfer(db, recipient, token), cancelEvent(db, adapter, owner, event.id, "Chuva forte.")]);
      expect(cancel.status).toBe("fulfilled");
      if (accept.status === "rejected") expect(accept.reason).toMatchObject({ code: "INVALID_STATE" });
      expect(await db.issuedTicket.count({ where: { eventId: event.id, status: "VALID" } })).toBe(0);
      expect(await db.ticketTransfer.count({ where: { eventId: event.id, status: "PENDING" } })).toBe(0);
      await expectSingleRefundToPayer(order.id, payment.id, order.totalCents);
    }
  });
});

describe("V1.6 — manutenção (cron) no meio dos fluxos", () => {
  it("reembolsos do cancelamento retomados pela reconciliação, com transferências e reservas no meio", async () => {
    const { owner, event, buyer, order, payment, tickets } = await paidSetup({ quantity: 2 });
    const recipient = await makeUser();
    const moved = await transferAccepted(buyer, tickets[0].id, recipient);
    const { transferId } = await transfer(buyer, tickets[1].id, recipient);
    const second = await paidSetupOnEvent(event.id);
    const pendingBuyer = await makeUser();
    await buy(pendingBuyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);

    // Rodar a manutenção agora não muda nada do que está em curso.
    const idle = await runMaintenance();
    expect(idle).toMatchObject({ expiredOrders: 0, expiredTransfers: 0, violations: [] });
    expect((await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } })).status).toBe("PENDING");

    // Cancelamento sem estorno imediato (como numa queda logo após o commit).
    const res = await cancelEvent(db, adapter, owner, event.id, "Interdição do local.", { autoRefund: false });
    expect(res.refundIds).toHaveLength(2);
    expect(await db.refund.count({ where: { status: "REQUESTED" } })).toBe(2);
    // Manutenção concorrente com uma leitura do QR do destinatário e um novo pedido de reembolso.
    const [cron, scan, again] = await Promise.allSettled([
      runMaintenance(later(11 * MIN)),
      checkInTicket(db, owner, event.id, qrPayload(moved)),
      requestCustomerRefund(db, adapter, buyer, order.id),
    ]);
    expect(cron.status).toBe("fulfilled");
    if (cron.status === "fulfilled") {
      expect(cron.value.reconciliation.errors).toEqual([]);
      expect(cron.value.reconciliation.refundsResumed).toBe(2);
    }
    expect(scan.status === "fulfilled" && scan.value.result).toBe("EVENT_NOT_ACTIVE");
    expect(again.status).toBe("rejected");

    await expectSingleRefundToPayer(order.id, payment.id, order.totalCents);
    await expectSingleRefundToPayer(second.order.id, second.payment.id, second.order.totalCents);
    expect(await db.ticketTransfer.count({ where: { status: "PENDING" } })).toBe(0);
    // Rodar de novo é idempotente.
    const rerun = await runMaintenance(later(30 * MIN));
    expect(rerun.reconciliation.refundsResumed).toBe(0);
    expect(rerun.violations).toEqual([]);
  });

  it("convite vencido expira pela manutenção, mesmo com aceite concorrente; nada muda de dono depois do prazo", async () => {
    const { buyer, tickets, event, owner } = await paidSetup({ quantity: 1 });
    const recipient = await makeUser();
    const { token, expiresAt, transferId } = await transfer(buyer, tickets[0].id, recipient);
    const after = new Date(expiresAt.getTime() + 1);
    const [cron, accept] = await Promise.allSettled([runMaintenance(after), acceptTransfer(db, recipient, token, undefined, after)]);
    expect(cron.status).toBe("fulfilled");
    expect(accept.status).toBe("rejected");
    expect((await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } })).status).toBe("EXPIRED");
    const t = await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } });
    expect(t).toMatchObject({ holderUserId: buyer.id, validationToken: tickets[0].validationToken, status: "VALID" });
    expect((await checkInTicket(db, owner, event.id, qrPayload(t))).result).toBe("ADMITTED");
  });
});

async function paidSetupOnEvent(eventId: string) {
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, include: { ticketTypes: true } });
  const buyer = await makeUser();
  const { order, payment } = await buyAndPay(buyer, eventId, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  return { buyer, order: await db.order.findUniqueOrThrow({ where: { id: order.id } }), payment };
}
