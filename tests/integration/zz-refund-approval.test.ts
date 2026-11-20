// Aprovação antes do reembolso: reembolso manual do admin acima de R$ 500 espera o
// organizador (OWNER/FINANCE) ou outro admin financeiro; ingressos bloqueados até lá.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminRefundOrder,
  decideRefundApproval,
  listAdminPendingApprovals,
  listOrgPendingApprovals,
  processRefund,
  REFUND_APPROVAL_THRESHOLD_CENTS,
  requestCustomerRefund,
} from "@/server/services/refunds";
import { cancelEvent } from "@/server/services/cancellation";
import { handlePaymentWebhook } from "@/server/services/payments";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { operationalHealth } from "@/server/services/ops-health";
import { refundView } from "@/features/orders/status-view";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
  vi.restoreAllMocks();
});

const admin = (roles: ("SUPER_ADMIN" | "FINANCE" | "MODERATION" | "SUPPORT")[], email: string) =>
  db.user.create({ data: { email, name: email, passwordHash: "x", platformRole: "ADMIN", adminRoles: roles } });

/** Pedido pago de 2 ingressos de R$ 300 (acima do limite) ou de 1 de R$ 100 (abaixo). */
async function setup(opts: { big?: boolean } = { big: true }) {
  const owner = await makeUser();
  const finance = await makeUser();
  const manager = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: finance.id, role: "FINANCE" }, { userId: manager.id, role: "ADMIN" }] });
  const price = opts.big ? 30_000 : 10_000;
  const event = await makeEvent(org, { startsInDays: 20, tickets: [{ priceCents: price, quantityTotal: 10, maxPerOrder: 5 }] });
  const buyer = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: opts.big ? 2 : 1 }]);
  const requester = await admin(["FINANCE"], "pede@test.local");
  return { owner, finance, manager, org, event, buyer, order, requester };
}

const tickets = (orderId: string) => db.issuedTicket.findMany({ where: { orderId }, orderBy: { sequence: "asc" } });

describe("quando exige aprovação", () => {
  it("até R$ 500 o reembolso do admin segue direto ao provedor", async () => {
    const { order, requester } = await setup({ big: false });
    expect(order.totalCents).toBeLessThanOrEqual(REFUND_APPROVAL_THRESHOLD_CENTS);
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Pedido do cliente");
    expect(refund).toMatchObject({ status: "SUCCEEDED", approvalRequired: false });
  });

  it("acima de R$ 500: espera aprovação, bloqueia os ingressos e não chama o provedor", async () => {
    const { order, requester, owner, finance, buyer, org } = await setup();
    expect(order.totalCents).toBeGreaterThan(REFUND_APPROVAL_THRESHOLD_CENTS);
    const spy = vi.spyOn(adapter, "refundPayment");
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Cliente não pôde ir");
    expect(refund).toMatchObject({ status: "AWAITING_APPROVAL", approvalRequired: true, amountCents: order.totalCents });
    expect(spy).not.toHaveBeenCalled();
    expect((await tickets(order.id)).map((t) => [t.status, t.refundId])).toEqual([
      ["REVOKED", refund.id],
      ["REVOKED", refund.id],
    ]);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUND_PENDING");
    // Reprocessar (botão antigo / cron) não fura a aprovação.
    await processRefund(db, adapter, refund.id);
    expect(spy).not.toHaveBeenCalled();
    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("AWAITING_APPROVAL");
    // E-mails: OWNER e FINANCE pedem decisão; o comprador sabe do bloqueio.
    const mails = await db.emailOutbox.findMany({ where: { template: { in: ["REFUND_APPROVAL_REQUESTED", "REFUND_AWAITING_APPROVAL"] } } });
    expect(mails.map((m) => m.recipient).sort()).toEqual([order.buyerEmail, finance.email, owner.email].sort());
    // Filas e visão do comprador.
    expect((await listOrgPendingApprovals(db, owner, org.id)).map((r) => r.refundId)).toEqual([refund.id]);
    expect((await listAdminPendingApprovals(db, requester)).map((r) => r.requestedByEmail)).toEqual([requester.email]);
    expect(refundView("REFUND_PENDING", [refund])).toMatchObject({ title: "Reembolso em análise" });
    // Com reembolso aguardando, o comprador não abre outro.
    await expect(requestCustomerRefund(db, adapter, buyer, order.id)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("quem decide", () => {
  it("OWNER, FINANCE e outro admin financeiro; nunca quem pediu, ADMIN da organização ou admin sem finanças", async () => {
    const { order, requester, manager, owner } = await setup();
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Teste");
    await expect(decideRefundApproval(db, adapter, requester, refund.id, "APPROVE", "eu mesmo")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideRefundApproval(db, adapter, manager, refund.id, "APPROVE", "ok")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideRefundApproval(db, adapter, await makeUser(), refund.id, "APPROVE", "ok")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideRefundApproval(db, adapter, await admin(["MODERATION"], "mod@test.local"), refund.id, "APPROVE", "ok")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listOrgPendingApprovals(db, manager, order.organizationId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Dono da organização que também pediu (como admin) não aprova pelo outro caminho.
    await db.user.update({ where: { id: owner.id }, data: { platformRole: "ADMIN", adminRoles: ["FINANCE"] } });
    await db.refund.update({ where: { id: refund.id }, data: { requestedById: owner.id } });
    await expect(decideRefundApproval(db, adapter, { ...owner, platformRole: "ADMIN", adminRoles: ["FINANCE"] }, refund.id, "APPROVE", "ok")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const other = await admin(["FINANCE"], "outro@test.local");
    await expect(decideRefundApproval(db, adapter, other, refund.id, "APPROVE", "conferido")).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("organização suspensa: só o admin decide", async () => {
    const { order, requester, owner, org } = await setup();
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Teste");
    await db.organization.update({ where: { id: org.id }, data: { status: "SUSPENDED" } });
    await expect(decideRefundApproval(db, adapter, owner, refund.id, "APPROVE", "ok")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.organization.update({ where: { id: org.id }, data: { status: "APPROVED" } });
  });
});

describe("decisão", () => {
  it("FINANCE aprova: vai ao provedor e conclui; auditoria com quem aprovou", async () => {
    const { order, requester, finance } = await setup();
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Teste");
    const done = await decideRefundApproval(db, adapter, finance, refund.id, "APPROVE", "Conferido com o cliente");
    expect(done).toMatchObject({ status: "SUCCEEDED", approvalDecidedById: finance.id, approvalNote: "Conferido com o cliente" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
    expect(await db.auditLog.findFirst({ where: { action: "refund.approved", entityId: refund.id } })).toMatchObject({ actorUserId: finance.id });
    await expect(decideRefundApproval(db, adapter, finance, refund.id, "REJECT", "tarde")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("OWNER recusa: ingressos voltam a valer, pedido volta a pago, comprador avisado; novo pedido do admin é possível", async () => {
    const { order, requester, owner } = await setup();
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Teste");
    await expect(decideRefundApproval(db, adapter, owner, refund.id, "REJECT", "  ")).rejects.toMatchObject({ code: "VALIDATION" });
    const spy = vi.spyOn(adapter, "refundPayment");
    const rejected = await decideRefundApproval(db, adapter, owner, refund.id, "REJECT", "Cliente já entrou no evento anterior");
    expect(spy).not.toHaveBeenCalled();
    expect(rejected).toMatchObject({ status: "REJECTED", approvalDecidedById: owner.id });
    expect((await tickets(order.id)).map((t) => [t.status, t.refundId])).toEqual([
      ["VALID", null],
      ["VALID", null],
    ]);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await db.emailOutbox.count({ where: { template: "REFUND_APPROVAL_REJECTED", recipient: order.buyerEmail } })).toBe(1);
    expect(refundView("PAID", [rejected])).toMatchObject({ title: "Reembolso recusado" });
    const again = await adminRefundOrder(db, adapter, requester, order.id, "Segunda tentativa");
    expect(again.id).not.toBe(refund.id);
    expect(again.status).toBe("AWAITING_APPROVAL");
  });

  it("aprovar e recusar ao mesmo tempo: só uma decisão vale", async () => {
    const { order, requester, owner, finance } = await setup();
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Teste");
    const results = await Promise.allSettled([
      decideRefundApproval(db, adapter, owner, refund.id, "REJECT", "não"),
      decideRefundApproval(db, adapter, finance, refund.id, "APPROVE", "sim"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const final = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
    const ts = await tickets(order.id);
    if (final.status === "REJECTED") expect(ts.every((t) => t.status === "VALID")).toBe(true);
    else expect(final.status).toBe("SUCCEEDED");
  });

  it("parcial acima do limite: só os ingressos escolhidos ficam bloqueados; recusa devolve só eles", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org, { startsInDays: 20, tickets: [{ priceCents: 30_000, quantityTotal: 10, maxPerOrder: 5 }] });
    const { order } = await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 3 }]);
    const requester = await admin(["FINANCE"], "pede@test.local");
    const [a, b, c] = await tickets(order.id);
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Dois não vão", [a.id, b.id]);
    expect(refund).toMatchObject({ status: "AWAITING_APPROVAL", partial: true });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("VALID");
    await decideRefundApproval(db, adapter, owner, refund.id, "REJECT", "Fora da política");
    expect((await tickets(order.id)).map((t) => t.status)).toEqual(["VALID", "VALID", "VALID"]);
  });
});

describe("integrações", () => {
  it("evento cancelado: aprovação automática e reembolso de todos", async () => {
    const { order, requester, owner, event } = await setup();
    const other = (await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }])).order;
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Teste");
    await cancelEvent(db, adapter, owner, event.id, "Chuva forte");
    expect(await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).toMatchObject({ status: "SUCCEEDED", approvalNote: "Aprovado automaticamente: evento cancelado." });
    expect((await db.order.findMany({ where: { id: { in: [order.id, other.id] } }, select: { status: true } })).map((o) => o.status)).toEqual(["REFUNDED", "REFUNDED"]);
  });

  it("estorno feito direto no provedor conclui o reembolso que aguardava aprovação", async () => {
    const { order, requester } = await setup();
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Teste");
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id, status: "PAID" } });
    await adapter.refundPayment({ providerPaymentId: payment.providerPaymentId!, amountCents: order.totalCents, idempotencyKey: "fora-da-plataforma" });
    await handlePaymentWebhook(db, adapter, adapter.buildWebhook(payment.providerPaymentId!, "evt-estorno-externo"));
    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("SUCCEEDED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
  });

  it("aprovação parada há mais de 48 h gera alerta", async () => {
    const { order, requester } = await setup();
    const refund = await adminRefundOrder(db, adapter, requester, order.id, "Teste");
    expect((await operationalHealth(db)).map((c) => c.code)).not.toContain("REFUND_APPROVAL_STUCK");
    await db.refund.update({ where: { id: refund.id }, data: { createdAt: new Date(Date.now() - 49 * 3_600_000) } });
    expect((await operationalHealth(db)).find((c) => c.code === "REFUND_APPROVAL_STUCK")).toMatchObject({ count: 1, href: "/admin/pagamentos#aguardando-aprovacao" });
  });
});
