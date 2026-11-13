// Avisos ao comprador que faltavam: protocolo e resposta do pedido de cancelamento
// (R5) e ingressos que voltam a valer quando o admin desfaz um reembolso com falha.
// Cada aviso é gravado na fila na mesma transação da mudança de estado: se a
// mudança perde a corrida ou é recusada, nenhum e-mail fica na fila.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaymentProviderAdapter, RefundResult } from "@/server/payments/types";
import { decryptPII } from "@/server/crypto";
import { createCancellationRequest, decideCancellationRequest, withdrawCancellationRequest } from "@/server/services/cancellation-requests";
import { adminRestoreAfterFailedRefund, requestCustomerRefund } from "@/server/services/refunds";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
});

async function paidOrder() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { startsInDays: 30, tickets: [{ priceCents: 10000, quantityTotal: 50 }] });
  const buyer = await makeUser();
  const admin = await makeUser({ admin: true });
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
  return { event, buyer, admin, order };
}

const outbox = (template: string) => db.emailOutbox.findMany({ where: { template } });
async function message(template: string) {
  const [job] = await outbox(template);
  expect(job).toBeDefined();
  return { job, msg: JSON.parse(decryptPII(job.messageEncrypted!)) as { to: string; subject: string; text: string; html: string } };
}

const refusingAdapter = Object.assign(Object.create(adapter) as PaymentProviderAdapter, {
  async refundPayment(input: { providerPaymentId: string }): Promise<RefundResult> {
    return { providerRefundId: `sim-refund-${input.providerPaymentId}`, status: "FAILED" };
  },
});

describe("pedido de cancelamento com protocolo", () => {
  it("ao abrir, envia o protocolo e o prazo para o e-mail do pedido", async () => {
    const { buyer, order } = await paidOrder();
    const request = await createCancellationRequest(db, buyer, order.id, "Não poderei ir.");
    const { job, msg } = await message("CANCELLATION_REQUEST_RECEIVED");
    expect(job.recipient).toBe(order.buyerEmail.toLowerCase());
    expect(msg.subject).toMatch(/pedido de cancelamento/i);
    expect(msg.text).toContain(request.protocol);
    expect(msg.text).toContain(order.publicCode);
    expect(msg.text).toMatch(/Responderemos até \d{2}\/\d{2}\/\d{4}/);
    expect(msg.text).toContain(`/pedido/${order.id}`);
    // O motivo do comprador não volta no e-mail.
    expect(msg.text).not.toContain("Não poderei ir.");
  });

  it("recusa: envia a resposta do admin e diz que os ingressos seguem válidos", async () => {
    const { buyer, admin, order } = await paidOrder();
    const request = await createCancellationRequest(db, buyer, order.id, "Mudei de ideia.");
    await decideCancellationRequest(db, adapter, admin, request.id, { decision: "REJECT", note: "Fora do prazo <b>da política</b>." });
    const { msg } = await message("CANCELLATION_REJECTED");
    expect(msg.text).toContain(request.protocol);
    expect(msg.text).toContain("Resposta: Fora do prazo <b>da política</b>.");
    expect(msg.text).toContain("continuam válidos");
    // Texto do admin escapado no HTML.
    expect(msg.html).toContain("&lt;b&gt;da política&lt;/b&gt;");
    expect(await outbox("CANCELLATION_APPROVED")).toHaveLength(0);
  });

  it("aprovação de pedido pago: avisa o reembolso aberto e, concluído, o e-mail do reembolso", async () => {
    const { buyer, admin, order } = await paidOrder();
    const request = await createCancellationRequest(db, buyer, order.id, "Viagem.");
    const { outcome } = await decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE" });
    expect(outcome).toBe("REFUND_OPENED");
    const { msg } = await message("CANCELLATION_APPROVED");
    expect(msg.text).toContain("reembolso integral de R$");
    expect(msg.text).not.toContain("Resposta:");
    expect(await outbox("REFUND_CONFIRMATION")).toHaveLength(1);
  });

  it("aprovação de pedido não pago: diz que nada foi cobrado", async () => {
    const owner = await makeUser();
    const event = await makeEvent(await makeOrg(owner), { startsInDays: 30, tickets: [{ priceCents: 10000, quantityTotal: 50 }] });
    const buyer = await makeUser();
    const admin = await makeUser({ admin: true });
    const order = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const request = await createCancellationRequest(db, buyer, order.id, "Desisti.");
    const { outcome } = await decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE" });
    expect(outcome).toBe("PENDING_ORDER_CANCELLED");
    expect((await message("CANCELLATION_APPROVED")).msg.text).toContain("nada foi cobrado");
  });

  it("duas decisões ao mesmo tempo: uma vence e só um e-mail de resposta fica na fila", async () => {
    const { buyer, admin, order } = await paidOrder();
    const other = await makeUser({ admin: true });
    const request = await createCancellationRequest(db, buyer, order.id, "Não poderei ir.");
    const results = await Promise.allSettled([
      decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE" }),
      decideCancellationRequest(db, adapter, other, request.id, { decision: "REJECT", note: "Não." }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const decided = await db.emailOutbox.count({ where: { template: { in: ["CANCELLATION_APPROVED", "CANCELLATION_REJECTED"] } } });
    expect(decided).toBe(1);
    const final = await db.cancellationRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(await outbox(final.status === "APPROVED" ? "CANCELLATION_APPROVED" : "CANCELLATION_REJECTED")).toHaveLength(1);
  });

  it("decisão recusada pelo estado do pedido não deixa e-mail na fila", async () => {
    const { buyer, admin, order } = await paidOrder();
    const request = await createCancellationRequest(db, buyer, order.id, "Não poderei ir.");
    await db.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    await expect(decideCancellationRequest(db, adapter, admin, request.id, { decision: "APPROVE" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await db.order.update({ where: { id: order.id }, data: { status: "PAID" } });
    expect(await outbox("CANCELLATION_APPROVED")).toHaveLength(0);
  });

  it("desistência do próprio comprador não gera e-mail de resposta", async () => {
    const { buyer, order } = await paidOrder();
    const request = await createCancellationRequest(db, buyer, order.id, "Não poderei ir.");
    await withdrawCancellationRequest(db, buyer, request.id);
    expect(await db.emailOutbox.count({ where: { template: { in: ["CANCELLATION_APPROVED", "CANCELLATION_REJECTED"] } } })).toBe(0);
  });
});

describe("reembolso com falha desfeito pelo admin", () => {
  it("avisa que os ingressos voltaram a valer, sem a observação interna do admin", async () => {
    const { buyer, admin, order } = await paidOrder();
    const refund = await requestCustomerRefund(db, refusingAdapter, buyer, order.id);
    expect((await db.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("FAILED");
    expect(await outbox("REFUND_RESTORED")).toHaveLength(0);

    const res = await adminRestoreAfterFailedRefund(db, adapter, admin, refund.id, "Nota interna do financeiro");
    expect(res.outcome).toBe("RESTORED");
    const { job, msg } = await message("REFUND_RESTORED");
    expect(job.recipient).toBe(order.buyerEmail.toLowerCase());
    expect(msg.text).toContain("voltaram a valer");
    expect(msg.text).toContain(order.publicCode);
    expect(msg.text).not.toContain("Nota interna");
    expect(await outbox("REFUND_CONFIRMATION")).toHaveLength(0);

    // Restaurar de novo é recusado e não duplica o aviso.
    await expect(adminRestoreAfterFailedRefund(db, adapter, admin, refund.id, "de novo")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await outbox("REFUND_RESTORED")).toHaveLength(1);
  });

  it("se o provedor já tinha estornado, não avisa restauração (o e-mail é o do reembolso)", async () => {
    const { buyer, admin, order } = await paidOrder();
    const refund = await requestCustomerRefund(db, refusingAdapter, buyer, order.id);
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const alreadyRefunded = Object.assign(Object.create(adapter) as PaymentProviderAdapter, {
      async getPayment() {
        return { ...(await adapter.getPayment(payment.providerPaymentId!)), status: "REFUNDED" as const };
      },
    });
    const res = await adminRestoreAfterFailedRefund(db, alreadyRefunded, admin, refund.id, "conferir");
    expect(res.outcome).toBe("ALREADY_REFUNDED");
    expect(await outbox("REFUND_RESTORED")).toHaveLength(0);
    expect(await outbox("REFUND_CONFIRMATION")).toHaveLength(1);
  });
});
