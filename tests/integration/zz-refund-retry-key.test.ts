// Retentativa de estorno: a chave de idempotência só muda depois de uma recusa
// definitiva do provedor e de conferir lá que o estorno não aconteceu.
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { ProviderRejectedError, type PaymentProviderAdapter } from "@/server/payments/types";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { adminRefundOrder, adminRetryRefund, refundRetryStates } from "@/server/services/refunds";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

type Step = "reject2031" | "uncertain" | "pass";

/**
 * Adaptador simulado que segue um roteiro no estorno e registra chaves e consultas.
 * `lookupsBefore[i]`: consultas ao provedor feitas antes do i-ésimo pedido de estorno
 * (depois de um estorno bem-sucedido há outra, para a tarifa, que não conta aqui).
 */
function scripted(steps: Step[]) {
  const keys: string[] = [];
  const lookupsBefore: number[] = [];
  let lookups = 0;
  const a = Object.create(adapter) as PaymentProviderAdapter;
  a.refundPayment = async (input) => {
    keys.push(input.idempotencyKey);
    lookupsBefore.push(lookups);
    const step = steps.shift() ?? "pass";
    if (step === "reject2031") throw new ProviderRejectedError(400, ["2031"], "Não foi possível concluir a operação com o Mercado Pago.");
    if (step === "uncertain") throw new AppError("PROVIDER_ERROR", "Não foi possível concluir a operação com o Mercado Pago.");
    return adapter.refundPayment(input);
  };
  a.getPayment = async (providerPaymentId) => {
    lookups++;
    return adapter.getPayment(providerPaymentId);
  };
  return { adapter: a, keys, lookupsBefore, lookups: () => lookups };
}

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 10 }] });
  const buyer = await makeUser();
  const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  const admin = await makeUser({ admin: true });
  return { order, payment, admin };
}

const refundOf = (id: string) => db.refund.findUniqueOrThrow({ where: { id } });

describe("chave de idempotência nas retentativas de estorno", () => {
  it("recusa por saldo (cause 2031): mensagem clara e chave nova na próxima tentativa, depois de conferir o provedor", async () => {
    const { order, admin } = await setup();
    const p = scripted(["reject2031", "pass"]);

    const failed = await adminRefundOrder(db, p.adapter, admin, order.id, "Pedido do comprador");
    expect(failed).toMatchObject({ status: "FAILED" });
    const note = (await refundOf(failed.id)).note!;
    expect(note).toMatch(/^PROVIDER_REJECTED: saldo insuficiente na conta Mercado Pago do organizador/);
    expect(note).toContain("cause 2031");
    expect(p.lookups()).toBe(0);

    const retried = await adminRetryRefund(db, p.adapter, admin, failed.id, "Saldo reposto");
    expect(retried.status).toBe("SUCCEEDED");
    expect(p.keys).toEqual([failed.idempotencyKey, `${failed.idempotencyKey}:r1`]);
    // Uma consulta antes do pedido com a chave nova (a primeira tentativa não consulta).
    expect(p.lookupsBefore).toEqual([0, 1]);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("se o estorno já aconteceu no provedor, a retentativa confirma sem pedir outro", async () => {
    const { order, payment, admin } = await setup();
    const p = scripted(["reject2031"]);
    const failed = await adminRefundOrder(db, p.adapter, admin, order.id, "Pedido do comprador");
    // Estornado por fora (ex.: o organizador devolveu pelo painel do Mercado Pago).
    await db.simulatedProviderPayment.update({ where: { id: payment.providerPaymentId! }, data: { state: "REFUNDED", refundedCents: 10000 } });

    const retried = await adminRetryRefund(db, p.adapter, admin, failed.id, "Conferir");
    expect(retried.status).toBe("SUCCEEDED");
    expect(p.keys).toHaveLength(1);
    expect(await db.auditLog.count({ where: { entityId: failed.id, action: "refund.found_refunded_before_retry" } })).toBe(1);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("falha incerta (timeout, 5xx) mantém a mesma chave e não consulta antes", async () => {
    const { order, admin } = await setup();
    const p = scripted(["uncertain", "pass"]);
    const failed = await adminRefundOrder(db, p.adapter, admin, order.id, "Pedido do comprador");
    expect((await refundOf(failed.id)).note).toMatch(/^PROVIDER_ERROR:/);

    const retried = await adminRetryRefund(db, p.adapter, admin, failed.id, "Nova tentativa");
    expect(retried.status).toBe("SUCCEEDED");
    expect(p.keys).toEqual([failed.idempotencyKey, failed.idempotencyKey]);
    expect(p.lookupsBefore).toEqual([0, 0]);
  });

  it("total estornado no provedor que não bate: não pede estorno e espera o admin", async () => {
    const { order, payment, admin } = await setup();
    const p = scripted(["reject2031"]);
    const failed = await adminRefundOrder(db, p.adapter, admin, order.id, "Pedido do comprador");
    await db.simulatedProviderPayment.update({ where: { id: payment.providerPaymentId! }, data: { refundedCents: 3000 } });

    const retried = await adminRetryRefund(db, p.adapter, admin, failed.id, "Nova tentativa");
    expect(retried.status).toBe("FAILED");
    expect(retried.note).toMatch(/^PROVIDER_STATE_MISMATCH:/);
    expect(p.keys).toHaveLength(1);
    const state = (await refundRetryStates(db, [retried])).get(failed.id)!;
    expect(state.awaitingAdminDecision).toBe(true);
  });
});
