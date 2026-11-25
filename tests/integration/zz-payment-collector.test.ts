import { beforeEach, describe, expect, it } from "vitest";
import { applyPaymentSnapshot, startPayment } from "@/server/services/payments";
import type { PaymentProviderAdapter } from "@/server/payments/types";
import { adapter, buy, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

// Achado #1 da auditoria de segurança (24/11/2026): um pagamento só confirma o pedido
// se o dinheiro foi para a conta da organização dona dele. Outra conta conectada não
// pode criar um pagamento com a nossa referência externa e o valor certo e emitir
// ingressos de um evento alheio.

beforeEach(resetDb);

/** O simulador com a conta recebedora de cada organização (como o Mercado Pago faz). */
function withReceivingAccounts(accounts: Record<string, string>): PaymentProviderAdapter {
  return Object.assign(Object.create(adapter) as PaymentProviderAdapter, {
    receivingAccountId: async (organizationId: string) => accounts[organizationId] ?? null,
  });
}

async function pendingOrder() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const order = await buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  const payment = await startPayment(db, adapter, buyer, order.id, "PIX");
  return { org, order, payment };
}

function paidElsewhere(payment: { id: string }, amountCents: number, collectorAccountId: string | null) {
  return {
    providerPaymentId: `other-account-${Math.random().toString(36).slice(2)}`,
    externalReference: payment.id,
    status: "PAID" as const,
    rawStatus: "approved:accredited",
    amountCents,
    processingFeeCents: 0,
    collectorAccountId,
  };
}

describe("conta recebedora do pagamento", () => {
  it.each([
    ["de outra organização", "mp-attacker"],
    ["ausente", null],
  ])("pagamento com conta recebedora %s não confirma o pedido nem emite ingresso", async (_label, collector) => {
    const { org, order, payment } = await pendingOrder();
    const mp = withReceivingAccounts({ [org.id]: "mp-victim" });

    const outcome = await applyPaymentSnapshot(db, mp, paidElsewhere(payment, order.totalCents, collector));

    expect(outcome).toBe("account_mismatch");
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PENDING_PAYMENT" });
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ status: "PENDING", providerPaymentId: payment.providerPaymentId });
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(0);
    expect(await db.financialLedgerEntry.count({ where: { orderId: order.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "payment.collector_mismatch", entityId: payment.id } })).toBe(1);
  });

  it("organização sem conta conectada não aceita pagamento de conta nenhuma", async () => {
    const { order, payment } = await pendingOrder();
    const outcome = await applyPaymentSnapshot(db, withReceivingAccounts({}), paidElsewhere(payment, order.totalCents, "mp-attacker"));
    expect(outcome).toBe("account_mismatch");
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PENDING_PAYMENT" });
  });

  it("pagamento recebido pela conta da organização confirma o pedido normalmente", async () => {
    const { org, order, payment } = await pendingOrder();
    const mp = withReceivingAccounts({ [org.id]: "mp-victim" });
    const snapshot = { ...(await adapter.getPayment(payment.providerPaymentId!)), status: "PAID" as const, collectorAccountId: "mp-victim" };

    expect(await applyPaymentSnapshot(db, mp, snapshot)).toBe("paid");
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID" });
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(1);
  });
});
