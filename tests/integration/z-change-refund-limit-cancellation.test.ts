// Fase 3 do Decreto 13.108/2026 na área financeira:
// L8a — reembolso integral enquanto a janela de uma alteração relevante estiver aberta;
// L4b — limite de ingressos por conta (`Event.maxTicketsPerAccount`);
// L5b — pedido de cancelamento com protocolo, decidido pelo admin.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelPendingOrder, createOrder, ticketsHeldByAccount } from "@/server/services/orders";
import { openChangeRefundWindow, refundEligibility, requestCustomerRefund } from "@/server/services/refunds";
import {
  PROVISIONAL_CANCELLATION_RESPONSE_DAYS,
  createCancellationRequest,
  decideCancellationRequest,
  listCancellationRequestsForAdmin,
  listMyCancellationRequests,
  withdrawCancellationRequest,
} from "@/server/services/cancellation-requests";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
});

const DAY = 86_400_000;
const later = (ms: number) => new Date(Date.now() + ms);

async function paidOrder(opts: { refundWindowDays?: number } = {}) {
  const owner = await makeUser();
  const buyer = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { startsInDays: 30 });
  if (opts.refundWindowDays !== undefined) await db.event.update({ where: { id: event.id }, data: { refundWindowDays: opts.refundWindowDays } });
  const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
  const paid = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  return { owner, buyer, org, event, order: paid, payment };
}

function recordChange(
  event: { id: string; organizationId: string },
  data: { createdAt: Date; refundUntil: Date | null; relevant?: boolean | null; extendsChangeId?: string },
) {
  return db.eventChange.create({
    data: {
      eventId: event.id,
      organizationId: event.organizationId,
      changedFields: data.extendsChangeId ? [] : ["startsAt"],
      before: { startsAt: "2026-12-01T22:00:00.000Z" },
      after: { startsAt: "2026-12-08T22:00:00.000Z" },
      reason: "Adiamento por questões técnicas.",
      relevant: data.relevant === undefined ? true : data.relevant,
      refundUntil: data.refundUntil,
      extendsChangeId: data.extendsChangeId,
      createdAt: data.createdAt,
    },
  });
}

describe("Z1 — reembolso integral por alteração relevante (L8a)", () => {
  it("concede reembolso integral, com taxas, fora dos prazos normais do evento", async () => {
    const { buyer, event, order, payment } = await paidOrder({ refundWindowDays: 0 });
    const now = later(60_000);
    // Fora da política normal: prazo de 0 dias após a compra.
    await expect(requestCustomerRefund(db, adapter, buyer, order.id, now)).rejects.toThrow("O prazo de 0 dias após a compra terminou.");

    const change = await recordChange(event, { createdAt: later(1_000), refundUntil: later(5 * DAY) });
    const window = await openChangeRefundWindow(db, event.id, order.paidAt, now);
    expect(window).toMatchObject({ eventChangeId: change.id, grantedById: change.id });
    const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id } });
    const check = refundEligibility(order, event, tickets, now, window);
    expect(check).toMatchObject({ eligible: true, basis: "EVENT_CHANGED" });
    expect(check.eligible && check.basis === "EVENT_CHANGED" && check.message).toMatch(/reembolso integral, com as taxas, até \d{2}\/\d{2}\/\d{4}/);

    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, now);
    expect(refund).toMatchObject({ status: "SUCCEEDED", reason: "EVENT_CHANGED", eventChangeId: change.id, amountCents: order.totalCents, paymentId: payment.id });
    expect(order.serviceFeeCents).toBeGreaterThanOrEqual(0);
    expect(refund.amountCents).toBe(order.subtotalCents + order.serviceFeeCents - order.discountCents);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
  });

  it("não vale para pedido pago depois da alteração, nem com janela vencida ou alteração não relevante", async () => {
    const { buyer, event, order } = await paidOrder({ refundWindowDays: 0 });
    const now = later(10 * DAY);
    // Alteração antes do pagamento.
    await recordChange(event, { createdAt: new Date(order.paidAt!.getTime() - 60_000), refundUntil: later(30 * DAY) });
    // Janela já vencida em `now`.
    await recordChange(event, { createdAt: later(1_000), refundUntil: later(2 * DAY) });
    // Não relevante e ainda sem decisão (D2).
    await recordChange(event, { createdAt: later(1_000), refundUntil: later(30 * DAY), relevant: false });
    await recordChange(event, { createdAt: later(1_000), refundUntil: later(30 * DAY), relevant: null });
    expect(await openChangeRefundWindow(db, event.id, order.paidAt, now)).toBeNull();
    await expect(requestCustomerRefund(db, adapter, buyer, order.id, now)).rejects.toThrow("O prazo de 0 dias após a compra terminou.");
    // Último instante da janela ainda vale (now <= refundUntil).
    const edge = await recordChange(event, { createdAt: later(2_000), refundUntil: now });
    expect((await openChangeRefundWindow(db, event.id, order.paidAt, now))?.eventChangeId).toBe(edge.id);
  });

  it("prorrogação vale para os pedidos da alteração original; vence o prazo mais longo", async () => {
    const first = await paidOrder({ refundWindowDays: 0 });
    const { event } = first;
    const original = await recordChange(event, { createdAt: new Date(), refundUntil: later(3 * DAY) });
    // Pedido pago depois da alteração original (e antes da prorrogação): não tem direito a ela.
    const second = await buyAndPay(first.buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const secondPaid = await db.order.findUniqueOrThrow({ where: { id: second.order.id } });
    expect(secondPaid.paidAt!.getTime()).toBeGreaterThan(original.createdAt.getTime());
    const extension = await recordChange(event, { createdAt: later(1_000), refundUntil: later(10 * DAY), extendsChangeId: original.id, relevant: null });
    const other = await recordChange(event, { createdAt: later(2_000), refundUntil: later(6 * DAY) });

    // Em 5 dias a original venceu, mas a prorrogação (10 dias) vence a `other` (6 dias).
    const now = later(5 * DAY);
    expect(await openChangeRefundWindow(db, event.id, first.order.paidAt, now)).toMatchObject({ eventChangeId: original.id, grantedById: extension.id });
    expect(await openChangeRefundWindow(db, event.id, first.order.paidAt, later(DAY))).toMatchObject({ eventChangeId: original.id, grantedById: extension.id });
    // O 2º pedido foi pago antes de `other`, então só `other` vale para ele.
    expect(await openChangeRefundWindow(db, event.id, secondPaid.paidAt, now)).toMatchObject({ eventChangeId: other.id });
    expect(await openChangeRefundWindow(db, event.id, secondPaid.paidAt, later(7 * DAY))).toBeNull();

    const refund = await requestCustomerRefund(db, adapter, first.buyer, first.order.id, now);
    expect(refund).toMatchObject({ status: "SUCCEEDED", reason: "EVENT_CHANGED", eventChangeId: original.id });
  });

  it("pedido com ingresso transferido: só o pagador pede, e o dinheiro volta ao pagamento dele (D7)", async () => {
    const { buyer, event, order, payment } = await paidOrder({ refundWindowDays: 0 });
    const holder = await makeUser();
    const [t1] = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
    await db.issuedTicket.update({ where: { id: t1.id }, data: { holderUserId: holder.id } });
    await recordChange(event, { createdAt: later(1_000), refundUntil: later(5 * DAY) });
    const now = later(60_000);

    await expect(requestCustomerRefund(db, adapter, holder, order.id, now)).rejects.toThrow("Você não tem permissão");
    const refund = await requestCustomerRefund(db, adapter, buyer, order.id, now);
    expect(refund).toMatchObject({ status: "SUCCEEDED", reason: "EVENT_CHANGED", paymentId: payment.id, amountCents: order.totalCents });
    const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id } });
    expect(tickets.every((t) => t.status === "REVOKED")).toBe(true);
    expect(await ticketsHeldByAccount(db, holder.id, event.id)).toBe(0);
  });

  it("ingresso já usado continua impedindo o reembolso pelo comprador", async () => {
    const { buyer, event, order } = await paidOrder({ refundWindowDays: 0 });
    await recordChange(event, { createdAt: later(1_000), refundUntil: later(5 * DAY) });
    const [t1] = await db.issuedTicket.findMany({ where: { orderId: order.id } });
    await db.issuedTicket.update({ where: { id: t1.id }, data: { status: "CHECKED_IN", checkedInAt: new Date() } });
    await expect(requestCustomerRefund(db, adapter, buyer, order.id, later(60_000))).rejects.toThrow("Há ingressos já utilizados neste pedido.");
  });
});

describe("Z2 — limite de ingressos por conta (L4b)", () => {
  it("conta ingressos em mãos e pedidos pendentes; transferência muda de quem conta", async () => {
    const owner = await makeUser();
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const org = await makeOrg(owner);
    const event = await makeEvent(org);
    await db.event.update({ where: { id: event.id }, data: { maxTicketsPerAccount: 3 } });
    const tt = event.ticketTypes[0].id;

    const { order } = await buyAndPay(a, event.id, [{ ticketTypeId: tt, quantity: 2 }]);
    expect(await ticketsHeldByAccount(db, a.id, event.id)).toBe(2);
    await expect(buy(a, event.id, [{ ticketTypeId: tt, quantity: 2 }])).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      message: "Este evento permite até 3 ingressos por conta. Você já tem 2 ingressos; pode comprar mais 1.",
    });
    const pending = await buy(a, event.id, [{ ticketTypeId: tt, quantity: 1 }]);
    expect(await ticketsHeldByAccount(db, a.id, event.id)).toBe(3);
    // Um novo pedido substitui o pendente: a quantidade dele não conta em dobro.
    const replaced = await buy(a, event.id, [{ ticketTypeId: tt, quantity: 1 }]);
    expect((await db.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("CANCELLED");
    expect(await ticketsHeldByAccount(db, a.id, event.id)).toBe(3);
    await cancelPendingOrder(db, a, replaced.id);
    expect(await ticketsHeldByAccount(db, a.id, event.id)).toBe(2);

    // Transferência para B: o ingresso passa a contar para B, não para A.
    const [t1] = await db.issuedTicket.findMany({ where: { orderId: order.id } });
    await db.issuedTicket.update({ where: { id: t1.id }, data: { holderUserId: b.id } });
    expect(await ticketsHeldByAccount(db, a.id, event.id)).toBe(1);
    expect(await ticketsHeldByAccount(db, b.id, event.id)).toBe(1);
    await expect(buy(b, event.id, [{ ticketTypeId: tt, quantity: 3 }])).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await buy(b, event.id, [{ ticketTypeId: tt, quantity: 2 }]);

    // Primeira compra já acima do limite.
    const c = await makeUser();
    await expect(buy(c, event.id, [{ ticketTypeId: tt, quantity: 4 }])).rejects.toThrow("Este evento permite até 3 ingressos por conta. Reduza a quantidade.");
  });

  it("sem limite (NULL) não restringe", async () => {
    const owner = await makeUser();
    const a = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org);
    const tt = event.ticketTypes[0].id;
    await buyAndPay(a, event.id, [{ ticketTypeId: tt, quantity: 10 }]);
    await buyAndPay(a, event.id, [{ ticketTypeId: tt, quantity: 10 }]);
    expect(await ticketsHeldByAccount(db, a.id, event.id)).toBe(20);
  });

  it("pedidos paralelos da mesma conta não passam do limite", async () => {
    const owner = await makeUser();
    const a = await makeUser();
    const org = await makeOrg(owner);
    // Gratuito: cada pedido é emitido na hora, então os pedidos não se substituem.
    const event = await makeEvent(org, { tickets: [{ priceCents: 0, quantityTotal: 100 }] });
    await db.event.update({ where: { id: event.id }, data: { maxTicketsPerAccount: 3 } });
    const tt = event.ticketTypes[0].id;
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => createOrder(db, a, orderInput(event.id, [{ ticketTypeId: tt, quantity: 1 }], { idempotencyKey: randomUUID() }), { providerIsSimulated: true })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(3);
    expect(rejected.every((r) => (r.reason as { code?: string }).code === "LIMIT_EXCEEDED")).toBe(true);
    expect(await ticketsHeldByAccount(db, a.id, event.id)).toBe(3);
    expect(await db.issuedTicket.count({ where: { eventId: event.id } })).toBe(3);
  });
});

describe("Z3 — pedido de cancelamento com protocolo (L5b)", () => {
  it("cria com protocolo legível e prazo provisório; um aberto por pedido; só o comprador", async () => {
    const { buyer, order, owner } = await paidOrder();
    const now = new Date();
    await expect(createCancellationRequest(db, buyer, order.id, "   ")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createCancellationRequest(db, owner, order.id, "Não sou o comprador")).rejects.toMatchObject({ code: "FORBIDDEN" });

    const request = await createCancellationRequest(db, buyer, order.id, "  Não poderei comparecer.  ", now);
    expect(request.protocol).toMatch(/^CAN-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(request).toMatchObject({ status: "OPEN", reason: "Não poderei comparecer.", autoEligibleAtRequest: true, requestedById: buyer.id });
    expect(request.respondBy!.getTime()).toBe(now.getTime() + PROVISIONAL_CANCELLATION_RESPONSE_DAYS * DAY);
    await expect(createCancellationRequest(db, buyer, order.id, "De novo")).rejects.toThrow(`protocolo ${request.protocol}`);

    expect((await listMyCancellationRequests(db, buyer)).map((r) => r.protocol)).toEqual([request.protocol]);
    expect(await listMyCancellationRequests(db, owner)).toEqual([]);
    await expect(listCancellationRequestsForAdmin(db, buyer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = await makeUser({ admin: true });
    expect((await listCancellationRequestsForAdmin(db, admin)).map((r) => r.id)).toEqual([request.id]);
    expect(await db.auditLog.count({ where: { entityType: "CancellationRequest", entityId: request.id, action: "cancellation.requested" } })).toBe(1);
  });

  it("recusa exige motivo, mantém o pedido pago e congela a decisão", async () => {
    const { buyer, order } = await paidOrder();
    const admin = await makeUser({ admin: true });
    const request = await createCancellationRequest(db, buyer, order.id, "Quero cancelar.");
    await expect(decideCancellationRequest(db, adapter, admin, request.id, { decision: "REJECT", note: " " })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(decideCancellationRequest(db, adapter, buyer, request.id, { decision: "REJECT", note: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const res = await decideCancellationRequest(db, adapter, admin, request.id, { decision: "REJECT", note: "Fora do prazo informado na compra." });
    expect(res).toMatchObject({ outcome: "NONE", refundId: null });
    expect(await db.cancellationRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "REJECTED", decidedById: admin.id, decisionNote: "Fora do prazo informado na compra." });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    await expect(decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE" })).rejects.toThrow("já foi decidido");
    // Decidido: um novo pedido pode ser aberto.
    await createCancellationRequest(db, buyer, order.id, "Novo pedido com mais detalhes.");
    expect(await db.auditLog.count({ where: { entityId: request.id, action: "cancellation.rejected" } })).toBe(1);
  });

  it("aprovação reembolsa pelo caminho normal, mesmo fora dos prazos; aprovar de novo não reembolsa em dobro", async () => {
    const { buyer, order, payment } = await paidOrder({ refundWindowDays: 0 });
    const admin = await makeUser({ admin: true });
    const request = await createCancellationRequest(db, buyer, order.id, "Problema de saúde.", later(60_000));
    expect(request.autoEligibleAtRequest).toBe(false);

    const res = await decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE", note: "Atestado apresentado." });
    expect(res.outcome).toBe("REFUND_OPENED");
    const refund = await db.refund.findUniqueOrThrow({ where: { id: res.refundId! } });
    expect(refund).toMatchObject({ status: "SUCCEEDED", reason: "ADMIN", cancellationRequestId: request.id, amountCents: order.totalCents, paymentId: payment.id });
    expect(refund.note).toContain(request.protocol);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
    await expect(decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE" })).rejects.toThrow("já foi decidido");
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("aprovações simultâneas: uma vence, um reembolso", async () => {
    const { buyer, order } = await paidOrder();
    const [admin1, admin2] = await Promise.all([makeUser({ admin: true }), makeUser({ admin: true })]);
    const request = await createCancellationRequest(db, buyer, order.id, "Cancelar, por favor.");
    const results = await Promise.allSettled([
      decideCancellationRequest(db, adapter, admin1, request.id, { decision: "APPROVE" }),
      decideCancellationRequest(db, adapter, admin2, request.id, { decision: "APPROVE" }),
      decideCancellationRequest(db, adapter, admin2, request.id, { decision: "REJECT", note: "Duplicado." }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.refund.count({ where: { orderId: order.id, status: { not: "REJECTED" } } })).toBeLessThanOrEqual(1);
  });

  it("aprovação concorrente com o reembolso pedido pelo comprador: nunca dois reembolsos", async () => {
    for (let round = 0; round < 4; round++) {
      const { buyer, order } = await paidOrder();
      const admin = await makeUser({ admin: true });
      const request = await createCancellationRequest(db, buyer, order.id, "Cancelar.");
      const results = await Promise.allSettled([
        requestCustomerRefund(db, adapter, buyer, order.id),
        decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE" }),
      ]);
      // A decisão sempre é aceita: abre o reembolso ou reconhece o que já existe.
      expect(results[1].status).toBe("fulfilled");
      const refunds = await db.refund.findMany({ where: { orderId: order.id } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0].status).toBe("SUCCEEDED");
      const outcome = results[1].status === "fulfilled" ? results[1].value.outcome : null;
      expect(outcome === "REFUND_OPENED" ? results[0].status === "rejected" : outcome === "REFUND_ALREADY_EXISTS").toBe(true);
      if (outcome === "REFUND_ALREADY_EXISTS" && results[1].status === "fulfilled") expect(results[1].value.refundId).toBe(refunds[0].id);
    }
  });

  it("pedido ainda não pago: aprovar libera a reserva; desistência pelo comprador", async () => {
    const owner = await makeUser();
    const buyer = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org);
    const pending = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    const admin = await makeUser({ admin: true });
    const request = await createCancellationRequest(db, buyer, pending.id, "Desisti antes de pagar.");
    expect(request.autoEligibleAtRequest).toBe(false);
    const res = await decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE" });
    expect(res.outcome).toBe("PENDING_ORDER_CANCELLED");
    expect((await db.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("CANCELLED");
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: event.ticketTypes[0].id } })).quantityReserved).toBe(0);

    // Pedido cancelado: aprovar não tem o que fazer (recusar é o caminho).
    const again = await createCancellationRequest(db, buyer, pending.id, "Outro.");
    await expect(decideCancellationRequest(db, adapter, admin, again.id, { decision: "APPROVE" })).rejects.toThrow(/não tem valor a reembolsar/);
    expect((await db.cancellationRequest.findUniqueOrThrow({ where: { id: again.id } })).status).toBe("OPEN");

    const stranger = await makeUser();
    await expect(withdrawCancellationRequest(db, stranger, again.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await withdrawCancellationRequest(db, buyer, again.id)).status).toBe("WITHDRAWN");
    await expect(withdrawCancellationRequest(db, buyer, again.id)).rejects.toThrow("já foi respondido");
  });
});
