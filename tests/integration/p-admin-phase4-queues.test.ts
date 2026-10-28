// Telas do admin da Fase 4: fila de cancelamentos, reembolsos com falha,
// transferências, janelas de alteração e filtros de auditoria. As leituras
// são do admin (admin-oversight); as decisões passam pelos serviços de domínio.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaymentProviderAdapter, RefundResult } from "@/server/payments/types";
import {
  ADMIN_PAGE_SIZE,
  adminQueueCounts,
  getCancellationRequestDetail,
  listAuditLogs,
  listCancellationQueue,
  listOpenChangeWindows,
  parseAuditPreset,
  parseCancellationStatus,
  parsePage,
  searchTransfers,
  transferPatternReport,
} from "@/server/services/admin-oversight";
import { createCancellationRequest, decideCancellationRequest } from "@/server/services/cancellation-requests";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { adminRestoreAfterFailedRefund, adminRetryRefund, listFailedRefunds, requestCustomerRefund } from "@/server/services/refunds";
import { requestTransfer } from "@/server/services/transfers";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
});

const DAY = 86_400_000;
type User = Awaited<ReturnType<typeof makeUser>>;

async function paidOrder(buyer?: User, quantity = 1) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { startsInDays: 30 });
  const customer = buyer ?? (await makeUser());
  const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity }]);
  return { event, customer, order: await db.order.findUniqueOrThrow({ where: { id: order.id } }) };
}

function refusingAdapter() {
  return Object.assign(Object.create(adapter) as PaymentProviderAdapter, {
    async refundPayment(input: { providerPaymentId: string }): Promise<RefundResult> {
      return { providerRefundId: `sim-refund-${input.providerPaymentId}`, status: "FAILED" };
    },
  });
}

describe("autorização: só admin ativo da plataforma", () => {
  it("recusa cliente e admin suspenso em todas as leituras e decisões novas", async () => {
    const customer = await makeUser();
    const suspendedAdmin = await db.user.update({ where: { id: (await makeUser({ admin: true })).id }, data: { status: "SUSPENDED" } });
    const { order, customer: buyer } = await paidOrder();
    const request = await createCancellationRequest(db, buyer, order.id, "Não poderei ir.");
    const fake = "nao-existe";
    for (const actor of [customer, suspendedAdmin]) {
      const calls: Promise<unknown>[] = [
        listCancellationQueue(db, actor),
        getCancellationRequestDetail(db, actor, request.id),
        adminQueueCounts(db, actor),
        searchTransfers(db, actor, { q: "x" }),
        transferPatternReport(db, actor),
        listOpenChangeWindows(db, actor),
        listAuditLogs(db, actor),
        listFailedRefunds(db, actor),
        decideCancellationRequest(db, adapter, actor, request.id, { decision: "APPROVE", note: "ok" }),
        decideCancellationRequest(db, adapter, actor, request.id, { decision: "REJECT", note: "não" }),
        adminRetryRefund(db, adapter, actor, fake, "tentar"),
        adminRestoreAfterFailedRefund(db, adapter, actor, fake, "restaurar"),
      ];
      for (const call of calls) await expect(call).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // Nada mudou.
    expect(await db.cancellationRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: "OPEN", decidedById: null });
    expect(await db.refund.count()).toBe(0);
  });
});

describe("fila de pedidos de cancelamento", () => {
  it("ordena pelo prazo, destaca os vencidos e filtra por status", async () => {
    const admin = await makeUser({ admin: true });
    const a = await paidOrder();
    const b = await paidOrder();
    const c = await paidOrder();
    const now = new Date();
    const overdue = await createCancellationRequest(db, a.customer, a.order.id, "Pedido antigo.", new Date(now.getTime() - 10 * DAY));
    const recent = await createCancellationRequest(db, b.customer, b.order.id, "Pedido novo.", now);
    const decided = await createCancellationRequest(db, c.customer, c.order.id, "Vou recusar.", now);
    await decideCancellationRequest(db, adapter, admin, decided.id, { decision: "REJECT", note: "Fora da política." });

    const open = await listCancellationQueue(db, admin, {}, now);
    expect(open.items.map((r) => [r.id, r.overdue])).toEqual([
      [overdue.id, true],
      [recent.id, false],
    ]);
    expect(open.overdueCount).toBe(1);
    expect((await listCancellationQueue(db, admin, { overdueOnly: true }, now)).items.map((r) => r.id)).toEqual([overdue.id]);
    expect((await listCancellationQueue(db, admin, { status: "REJECTED" }, now)).items.map((r) => r.id)).toEqual([decided.id]);
    expect(await adminQueueCounts(db, admin, now)).toMatchObject({ openCancellations: 2, overdueCancellations: 1 });
    expect(parseCancellationStatus("hack")).toBe("OPEN");
  });

  it("aprovação pelo serviço de domínio: duplo clique gera um único reembolso, visível no detalhe", async () => {
    const admin = await makeUser({ admin: true });
    const { order, customer } = await paidOrder(undefined, 2);
    const request = await createCancellationRequest(db, customer, order.id, "Mudança de planos.");
    const before = await getCancellationRequestDetail(db, admin, request.id);
    expect(before.request.order.status).toBe("PAID");
    expect(before.ticketCounts).toEqual({ VALID: 2 });

    const results = await Promise.allSettled([
      decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE", note: "Dentro do prazo." }),
      decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE", note: "Dentro do prazo." }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "INVALID_STATE" } });

    const after = await getCancellationRequestDetail(db, admin, request.id);
    expect(after.request).toMatchObject({ status: "APPROVED", decidedById: admin.id, decisionNote: "Dentro do prazo." });
    expect(after.request.order.status).toBe("REFUNDED");
    expect(after.request.order.refunds).toHaveLength(1);
    expect(after.request.order.refunds[0]).toMatchObject({ status: "SUCCEEDED", reason: "ADMIN", cancellationRequestId: request.id, amountCents: order.totalCents });
    expect(await db.auditLog.count({ where: { action: "cancellation.approved", entityId: request.id } })).toBe(1);
  });

  it("aprovar × recusar ao mesmo tempo: uma decisão vence; recusa exige motivo", async () => {
    const admin = await makeUser({ admin: true });
    const { order, customer } = await paidOrder();
    const request = await createCancellationRequest(db, customer, order.id, "Quero cancelar.");
    await expect(decideCancellationRequest(db, adapter, admin, request.id, { decision: "REJECT", note: "  " })).rejects.toMatchObject({ code: "VALIDATION" });
    const results = await Promise.allSettled([
      decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE", note: "ok" }),
      decideCancellationRequest(db, adapter, admin, request.id, { decision: "REJECT", note: "não" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const final = await db.cancellationRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(final.status === "APPROVED" ? 1 : 0);
    expect(await db.auditLog.count({ where: { action: { startsWith: "cancellation." }, entityId: request.id, NOT: { action: "cancellation.requested" } } })).toBe(1);
  });

  it("detalhe de protocolo inexistente é NOT_FOUND", async () => {
    const admin = await makeUser({ admin: true });
    await expect(getCancellationRequestDetail(db, admin, "nao-existe")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reembolsos com falha (contrato do PR #16)", () => {
  it("lista o FAILED e reprocessa pelo serviço de domínio", async () => {
    const admin = await makeUser({ admin: true });
    const { order, customer } = await paidOrder();
    const refund = await requestCustomerRefund(db, refusingAdapter(), customer, order.id);
    expect(refund.status).toBe("FAILED");
    const failed = await listFailedRefunds(db, admin);
    expect(failed.map((f) => f.refundId)).toEqual([refund.id]);
    expect((await adminQueueCounts(db, admin)).failedRefunds).toBe(1);

    await expect(adminRetryRefund(db, adapter, admin, refund.id, " ")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await adminRetryRefund(db, adapter, admin, refund.id, "Provedor normalizado.")).toMatchObject({ status: "SUCCEEDED" });
    expect(await listFailedRefunds(db, admin)).toEqual([]);
  });

  it("restaura os ingressos pelo serviço de domínio e o pedido volta a pago", async () => {
    const admin = await makeUser({ admin: true });
    const { order, customer } = await paidOrder();
    const refusing = refusingAdapter();
    const refund = await requestCustomerRefund(db, refusing, customer, order.id);
    expect(await adminRestoreAfterFailedRefund(db, refusing, admin, refund.id, "Comprador desistiu do reembolso.")).toMatchObject({ outcome: "RESTORED" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await listFailedRefunds(db, admin)).toEqual([]);
  });
});

describe("transferências (somente leitura)", () => {
  it("busca por código, e-mail e evento, sem expor tokens, e sinaliza envios em série", async () => {
    const admin = await makeUser({ admin: true });
    const { event, customer, order } = await paidOrder(undefined, 3);
    const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
    const recipients = [await makeUser(), await makeUser(), await makeUser()];
    for (const [i, t] of tickets.entries()) await requestTransfer(db, customer, t.id, { toEmail: recipients[i].email, toName: `Destino ${i}` });

    const byCode = await searchTransfers(db, admin, { q: tickets[1].code.toLowerCase() });
    expect(byCode.items.map((t) => t.ticket.code)).toEqual([tickets[1].code]);
    expect(byCode.items[0]).not.toHaveProperty("tokenHash");
    expect((await searchTransfers(db, admin, { q: recipients[2].email.toUpperCase() })).total).toBe(1);
    expect((await searchTransfers(db, admin, { q: customer.email })).total).toBe(3);
    expect((await searchTransfers(db, admin, { q: event.title })).total).toBe(3);
    expect((await searchTransfers(db, admin, { status: "ACCEPTED" })).total).toBe(0);

    const report = await transferPatternReport(db, admin);
    expect(report.senders).toEqual([expect.objectContaining({ key: customer.email, count: 3 })]);
    expect(report.recipients).toEqual([]);
    expect((await transferPatternReport(db, admin, { minCount: 4 })).senders).toEqual([]);
    // Fora da janela não conta.
    expect((await transferPatternReport(db, admin, {}, new Date(Date.now() + 2 * DAY))).senders).toEqual([]);
    // Nada foi alterado pelo relatório.
    expect(await db.ticketTransfer.count({ where: { status: "PENDING" } })).toBe(3);
  });
});

describe("janelas de reembolso por alteração", () => {
  it("lista janelas abertas (com prorrogação) e conta os reembolsos pedidos por elas", async () => {
    const admin = await makeUser({ admin: true });
    const { event, customer, order } = await paidOrder();
    const other = await paidOrder();
    const now = Date.now();
    const change = await db.eventChange.create({
      data: {
        eventId: event.id,
        organizationId: event.organizationId,
        changedFields: ["startsAt"],
        before: {},
        after: {},
        reason: "Adiamento.",
        relevant: true,
        refundUntil: new Date(now + 2 * DAY),
        createdAt: new Date(now + 1_000),
      },
    });
    await db.eventChange.create({
      data: { eventId: event.id, organizationId: event.organizationId, changedFields: [], before: {}, after: {}, reason: "Prorrogação.", refundUntil: new Date(now + 9 * DAY), extendsChangeId: change.id },
    });
    // Fechada (vencida) e não relevante: fora da lista.
    await db.eventChange.create({
      data: { eventId: other.event.id, organizationId: other.event.organizationId, changedFields: ["venue"], before: {}, after: {}, reason: "Troca.", relevant: true, refundUntil: new Date(now - DAY), createdAt: new Date(now - 2 * DAY) },
    });
    await db.eventChange.create({
      data: { eventId: other.event.id, organizationId: other.event.organizationId, changedFields: ["title"], before: {}, after: {}, reason: "Título.", relevant: false, refundUntil: new Date(now + DAY) },
    });

    const later = new Date(now + 5_000);
    let list = await listOpenChangeWindows(db, admin, {}, later);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: change.id, extended: true, refundsTotal: 0, paidOrdersStillEligible: 1 });
    expect(list.items[0].effectiveRefundUntil.getTime()).toBe(now + 9 * DAY);

    const refund = await requestCustomerRefund(db, adapter, customer, order.id, later);
    expect(refund).toMatchObject({ reason: "EVENT_CHANGED", eventChangeId: change.id });
    list = await listOpenChangeWindows(db, admin, {}, later);
    expect(list.items[0]).toMatchObject({ refundsTotal: 1, refundsByStatus: { SUCCEEDED: 1 }, refundedCents: order.totalCents, paidOrdersStillEligible: 0 });
    // Depois da prorrogação, a janela some.
    expect((await listOpenChangeWindows(db, admin, {}, new Date(now + 10 * DAY))).items).toEqual([]);
  });
});

describe("auditoria: filtros e paginação", () => {
  it("filtra pelos grupos novos e pagina", async () => {
    const admin = await makeUser({ admin: true });
    const { order, customer } = await paidOrder();
    const request = await createCancellationRequest(db, customer, order.id, "Motivo.");
    await decideCancellationRequest(db, adapter, admin, request.id, { decision: "REJECT", note: "Fora do prazo." });
    await db.auditLog.createMany({
      data: Array.from({ length: ADMIN_PAGE_SIZE + 2 }, (_, i) => ({ action: "terms.accepted", entityType: "TermsAcceptance", entityId: `t${i}` })),
    });

    const cancellations = await listAuditLogs(db, admin, { preset: "cancellation" });
    expect(cancellations.items.map((l) => l.action).sort()).toEqual(["cancellation.rejected", "cancellation.requested"]);
    const terms1 = await listAuditLogs(db, admin, { preset: "terms" });
    expect(terms1).toMatchObject({ total: ADMIN_PAGE_SIZE + 2, page: 1, pageCount: 2 });
    expect(terms1.items).toHaveLength(ADMIN_PAGE_SIZE);
    const terms2 = await listAuditLogs(db, admin, { preset: "terms", page: 2 });
    expect(terms2.items).toHaveLength(2);
    expect(new Set([...terms1.items, ...terms2.items].map((l) => l.id)).size).toBe(ADMIN_PAGE_SIZE + 2);
    // Página além do fim volta para a última.
    expect((await listAuditLogs(db, admin, { preset: "terms", page: 99 })).page).toBe(2);
    // Grupo + texto livre se combinam.
    expect((await listAuditLogs(db, admin, { preset: "cancellation", action: "cancellation.rej" })).total).toBe(1);
    expect(parseAuditPreset("toString")).toBeUndefined();
    expect(parsePage("-3")).toBe(1);
    expect(parsePage("2")).toBe(2);
  });
});
