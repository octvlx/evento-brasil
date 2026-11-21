// Estorno com tarifa de processamento: o Mercado Pago devolve a tarifa, e o razão
// lança essa devolução (por diferença, sem duplicar) depois do reembolso.
import { beforeEach, describe, expect, it } from "vitest";
import type { PaymentProviderAdapter } from "@/server/payments/types";
import { syncPaymentFromProvider } from "@/server/services/payments";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { adminRefundOrder } from "@/server/services/refunds";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

/** Simulado com tarifa: `fee.cents` é o que o provedor informa como tarifa retida no momento. */
function withFee(initialCents: number) {
  const fee = { cents: initialCents };
  const a = Object.create(adapter) as PaymentProviderAdapter;
  a.getPayment = async (providerPaymentId) => ({ ...(await adapter.getPayment(providerPaymentId)), processingFeeCents: fee.cents });
  return { adapter: a, fee };
}

async function balance(orderId: string, account: "PROCESSING_FEES" | "ORGANIZER_PAYABLE") {
  const entries = await db.financialLedgerEntry.findMany({ where: { orderId, account } });
  return entries.reduce((sum, e) => sum + (e.direction === "CREDIT" ? e.amountCents : -e.amountCents), 0);
}

describe("tarifa de processamento no estorno", () => {
  it("tarifa devolvida pelo provedor no estorno integral sai do razão, e repetir a consulta não duplica", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 10 }] });
    const buyer = await makeUser();
    const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const provider = withFee(150);

    // O provedor informa a tarifa da venda.
    await syncPaymentFromProvider(db, provider.adapter, payment.providerPaymentId!);
    expect(await balance(order.id, "PROCESSING_FEES")).toBe(150);

    // Estorno integral: o provedor devolve a tarifa (como o Mercado Pago fez no pagamento real).
    provider.fee.cents = 0;
    const admin = await makeUser({ admin: true });
    const refund = await adminRefundOrder(db, provider.adapter, admin, order.id, "Pedido do comprador");
    expect(refund.status).toBe("SUCCEEDED");
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");

    expect(await balance(order.id, "PROCESSING_FEES")).toBe(0);
    // O organizador devolveu a parte dele da venda e recebeu de volta a tarifa: fica zerado.
    expect(await balance(order.id, "ORGANIZER_PAYABLE")).toBe(0);
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).processingFeeCents).toBe(0);

    // Webhook ou reconciliação depois: mesma tarifa, nenhum lançamento novo.
    const count = await db.financialLedgerEntry.count({ where: { orderId: order.id } });
    await syncPaymentFromProvider(db, provider.adapter, payment.providerPaymentId!);
    expect(await db.financialLedgerEntry.count({ where: { orderId: order.id } })).toBe(count);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("se o provedor ainda não devolveu a tarifa, o razão não muda; quando devolver, o webhook acerta", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 10 }] });
    const buyer = await makeUser();
    const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const provider = withFee(150);
    await syncPaymentFromProvider(db, provider.adapter, payment.providerPaymentId!);

    const admin = await makeUser({ admin: true });
    await adminRefundOrder(db, provider.adapter, admin, order.id, "Pedido do comprador");
    expect(await balance(order.id, "PROCESSING_FEES")).toBe(150);

    provider.fee.cents = 0;
    await syncPaymentFromProvider(db, provider.adapter, payment.providerPaymentId!);
    expect(await balance(order.id, "PROCESSING_FEES")).toBe(0);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });
});
