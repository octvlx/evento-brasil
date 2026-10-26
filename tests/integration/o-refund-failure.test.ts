// Política para reembolso FAILED: o provedor recusa/falha depois que os ingressos
// já foram revogados. Retentativas automáticas limitadas (mesma chave de
// idempotência) e, esgotadas, decisão explícita do admin: reprocessar ou
// restaurar os ingressos e voltar o pedido a PAID. Nunca silencioso.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaymentProviderAdapter, RefundResult } from "@/server/payments/types";
import { cancelEvent } from "@/server/services/cancellation";
import { checkInTicket } from "@/server/services/checkin";
import { checkFinancialInvariants, reconcilePayments } from "@/server/services/reconciliation";
import {
  adminRestoreAfterFailedRefund,
  adminRetryRefund,
  listFailedRefunds,
  REFUND_RETRY_POLICY,
  requestCustomerRefund,
} from "@/server/services/refunds";
import { qrPayload } from "@/server/services/tickets";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(async () => {
  expect(await checkFinancialInvariants(db)).toEqual([]);
});

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);

type Step = "refuse" | "throw" | "ok" | "ok-then-throw";

/** Provedor simulado com o estorno roteirizado; depois do roteiro, repete o último passo. */
function scriptedAdapter(steps: Step[]) {
  const calls: { idempotencyKey: string }[] = [];
  const flaky: PaymentProviderAdapter = Object.assign(Object.create(adapter) as PaymentProviderAdapter, {
    async refundPayment(input: { providerPaymentId: string; amountCents: number; idempotencyKey: string }): Promise<RefundResult> {
      const step = steps[Math.min(calls.length, steps.length - 1)];
      calls.push({ idempotencyKey: input.idempotencyKey });
      if (step === "refuse") return { providerRefundId: `sim-refund-${input.providerPaymentId}`, status: "FAILED" };
      if (step === "throw") throw new Error("timeout simulado");
      const res = await adapter.refundPayment(input);
      if (step === "ok-then-throw") throw new Error("conexão caiu depois do estorno");
      return res;
    },
  });
  return { flaky, calls };
}

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 50 }] });
  const customer = await makeUser();
  const admin = await makeUser({ admin: true });
  const { order, payment } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
  return { owner, event, tt: event.ticketTypes[0], customer, admin, order, payment };
}

const state = async (orderId: string) => {
  const [order, refunds, tickets, sim] = await Promise.all([
    db.order.findUniqueOrThrow({ where: { id: orderId } }),
    db.refund.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
    db.issuedTicket.findMany({ where: { orderId }, orderBy: { sequence: "asc" } }),
    db.simulatedProviderPayment.findFirstOrThrow(),
  ]);
  return { order, refunds, tickets, sim };
};

const attemptAudits = (refundId: string) => db.auditLog.count({ where: { entityType: "Refund", entityId: refundId, action: "refund.attempt_failed" } });

/** Esgota as tentativas automáticas com um provedor que sempre recusa. */
async function exhaust(orderId: string, customer: Parameters<typeof requestCustomerRefund>[2]) {
  const { flaky, calls } = scriptedAdapter(["refuse"]);
  const refund = await requestCustomerRefund(db, flaky, customer, orderId);
  for (const m of [6, 40, 3 * 60]) await reconcilePayments(db, flaky, minutesFromNow(m));
  expect(calls).toHaveLength(REFUND_RETRY_POLICY.maxAutomaticAttempts);
  return refund;
}

describe("recusa do provedor", () => {
  it("deixa o pedido em REFUND_PENDING, ingressos bloqueados e a falha registrada (não silenciosa)", async () => {
    const { owner, event, customer, admin, order } = await setup();
    const { flaky } = scriptedAdapter(["refuse"]);
    const refund = await requestCustomerRefund(db, flaky, customer, order.id);
    expect(refund).toMatchObject({ status: "FAILED", note: expect.stringContaining("PROVIDER_REFUSED") });

    const s = await state(order.id);
    expect(s.order.status).toBe("REFUND_PENDING");
    expect(s.tickets.map((t) => t.status)).toEqual(["REVOKED", "REVOKED"]);
    expect(s.sim.state).toBe("APPROVED"); // dinheiro não saiu
    expect(await attemptAudits(refund.id)).toBe(1);

    // O ingresso continua sem uso enquanto o estorno está pendente.
    expect((await checkInTicket(db, owner, event.id, qrPayload(s.tickets[0]))).result).toBe("REVOKED");

    const [queued] = await listFailedRefunds(db, admin);
    expect(queued).toMatchObject({ refundId: refund.id, attempts: 1, awaitingAdminDecision: false, restoreBlockedReason: null });
    expect(queued.nextRetryAt!.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    await expect(listFailedRefunds(db, customer)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("erro de rede também entra na política de retentativas", async () => {
    const { customer, order } = await setup();
    const { flaky } = scriptedAdapter(["throw"]);
    const refund = await requestCustomerRefund(db, flaky, customer, order.id);
    expect(refund).toMatchObject({ status: "FAILED", note: expect.stringContaining("PROVIDER_ERROR") });
    expect(await attemptAudits(refund.id)).toBe(1);
  });
});

describe("retentativa automática", () => {
  it("respeita a espera e conclui com a mesma chave de idempotência", async () => {
    const { tt, customer, order } = await setup();
    const { flaky, calls } = scriptedAdapter(["refuse", "ok"]);
    const refund = await requestCustomerRefund(db, flaky, customer, order.id);

    const early = await reconcilePayments(db, flaky, minutesFromNow(4));
    expect(early.refundsRetried).toBe(0);
    expect(calls).toHaveLength(1);

    const report = await reconcilePayments(db, flaky, minutesFromNow(6));
    expect(report).toMatchObject({ refundsRetried: 1, refundsRetrySucceeded: 1, refundsAwaitingAdminDecision: 0, errors: [] });
    expect(new Set(calls.map((c) => c.idempotencyKey))).toEqual(new Set([refund.idempotencyKey]));

    const s = await state(order.id);
    expect(s.order.status).toBe("REFUNDED");
    expect(s.refunds).toHaveLength(1);
    expect(s.refunds[0].status).toBe("SUCCEEDED");
    expect(s.sim.state).toBe("REFUNDED");
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).quantityRefunded).toBe(2);
    expect(await db.financialLedgerEntry.count({ where: { refundId: refund.id } })).toBeGreaterThan(0);
  });

  it("esgota as tentativas, avisa e passa a aguardar o admin", async () => {
    const { customer, admin, order } = await setup();
    const refund = await exhaust(order.id, customer);
    expect(await attemptAudits(refund.id)).toBe(REFUND_RETRY_POLICY.maxAutomaticAttempts);
    expect(await db.auditLog.count({ where: { entityId: refund.id, action: "refund.retry_exhausted" } })).toBe(1);

    // Nenhuma tentativa automática a mais, por mais tempo que passe.
    const { flaky, calls } = scriptedAdapter(["ok"]);
    const later = await reconcilePayments(db, flaky, minutesFromNow(48 * 60));
    expect(later).toMatchObject({ refundsRetried: 0, refundsAwaitingAdminDecision: 1 });
    expect(calls).toHaveLength(0);

    const [queued] = await listFailedRefunds(db, admin);
    expect(queued).toMatchObject({ attempts: 4, nextRetryAt: null, awaitingAdminDecision: true });
    expect(queued.note).toContain("aguardando decisão do admin");
    expect((await state(order.id)).order.status).toBe("REFUND_PENDING");
  });
});

describe("decisão do admin", () => {
  it("reprocessar: exige admin e motivo, e conclui o estorno", async () => {
    const { customer, admin, order } = await setup();
    const refund = await exhaust(order.id, customer);
    await expect(adminRetryRefund(db, adapter, customer, refund.id, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminRetryRefund(db, adapter, admin, refund.id, " ")).rejects.toMatchObject({ code: "VALIDATION" });

    const done = await adminRetryRefund(db, adapter, admin, refund.id, "Provedor normalizado");
    expect(done.status).toBe("SUCCEEDED");
    expect((await state(order.id)).order.status).toBe("REFUNDED");
    await expect(adminRetryRefund(db, adapter, admin, refund.id, "de novo")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("restaurar: ingressos válidos, pedido PAID, contadores e razão intactos; novo pedido de reembolso funciona", async () => {
    const { owner, event, tt, customer, admin, order } = await setup();
    const ledgerBefore = await db.financialLedgerEntry.count();
    const refund = await exhaust(order.id, customer);

    const res = await adminRestoreAfterFailedRefund(db, adapter, admin, refund.id, "Comprador prefere manter os ingressos");
    expect(res).toEqual({ outcome: "RESTORED", restoredTickets: 2 });

    const s = await state(order.id);
    expect(s.order.status).toBe("PAID");
    expect(s.refunds[0]).toMatchObject({ status: "REJECTED", note: expect.stringContaining("RESTORED_BY_ADMIN") });
    expect(s.tickets.map((t) => [t.status, t.revocationReason])).toEqual([["VALID", null], ["VALID", null]]);
    expect(s.sim.state).toBe("APPROVED");
    expect(await db.payment.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({ status: "PAID" });
    expect(await db.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).toMatchObject({ quantitySold: 2, quantityRefunded: 0 });
    expect(await db.financialLedgerEntry.count()).toBe(ledgerBefore);
    expect(await listFailedRefunds(db, admin)).toEqual([]);

    // Restaurar de novo não muda nada.
    await expect(adminRestoreAfterFailedRefund(db, adapter, admin, refund.id, "de novo")).rejects.toMatchObject({ code: "INVALID_STATE" });

    // Os ingressos voltam a valer na portaria.
    expect((await checkInTicket(db, owner, event.id, qrPayload(s.tickets[0]))).result).toBe("ADMITTED");
  });

  it("restaurado sem uso, o comprador pode pedir reembolso de novo (chave nova)", async () => {
    const { customer, admin, order } = await setup();
    const refund = await exhaust(order.id, customer);
    await adminRestoreAfterFailedRefund(db, adapter, admin, refund.id, "restaurar");
    const again = await requestCustomerRefund(db, adapter, customer, order.id);
    expect(again.id).not.toBe(refund.id);
    expect(again.idempotencyKey).not.toBe(refund.idempotencyKey);
    expect(again.status).toBe("SUCCEEDED");
    expect((await state(order.id)).order.status).toBe("REFUNDED");
  });

  it("restaurar quando o provedor estornou de fato (falha de rede): confirma em vez de devolver ingressos", async () => {
    const { tt, customer, admin, order } = await setup();
    const { flaky } = scriptedAdapter(["ok-then-throw"]);
    const refund = await requestCustomerRefund(db, flaky, customer, order.id);
    expect(refund.status).toBe("FAILED");
    expect((await state(order.id)).sim.state).toBe("REFUNDED");

    const res = await adminRestoreAfterFailedRefund(db, adapter, admin, refund.id, "tentar restaurar");
    expect(res.outcome).toBe("ALREADY_REFUNDED");
    const s = await state(order.id);
    expect(s.order.status).toBe("REFUNDED");
    expect(s.refunds[0].status).toBe("SUCCEEDED");
    expect(s.tickets.every((t) => t.status === "REVOKED")).toBe(true);
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).quantityRefunded).toBe(2);
  });

  it("evento cancelado: restaurar é recusado, só reprocessar", async () => {
    const { owner, event, admin, order } = await setup();
    const { flaky } = scriptedAdapter(["refuse"]);
    await cancelEvent(db, flaky, owner, event.id, "Chuva");
    const [refund] = (await state(order.id)).refunds;
    expect(refund).toMatchObject({ status: "FAILED", reason: "EVENT_CANCELLED" });

    const [queued] = await listFailedRefunds(db, admin);
    expect(queued.restoreBlockedReason).toMatch(/não pode ser desfeito/);
    await expect(adminRestoreAfterFailedRefund(db, adapter, admin, refund.id, "restaurar")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await adminRetryRefund(db, adapter, admin, refund.id, "reprocessar")).status).toBe("SUCCEEDED");
  });

  it("o verificador de invariantes detecta ingresso válido em pedido aguardando reembolso", async () => {
    const { customer, order } = await setup();
    const { flaky } = scriptedAdapter(["refuse"]);
    await requestCustomerRefund(db, flaky, customer, order.id);
    await db.issuedTicket.updateMany({ where: { orderId: order.id }, data: { status: "VALID", revokedAt: null, revocationReason: null } });
    expect((await checkFinancialInvariants(db)).map((v) => v.code)).toContain("VALID_TICKET_ON_REFUND_PENDING_ORDER");
    await db.issuedTicket.updateMany({ where: { orderId: order.id }, data: { status: "REVOKED", revokedAt: new Date(), revocationReason: "REFUNDED" } });
  });
});

describe("concorrência", () => {
  it("restauração × check-in: nenhuma entrada enquanto o pedido aguarda reembolso", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { owner, event, customer, admin, order } = await setup();
      const { flaky } = scriptedAdapter(["refuse"]);
      const refund = await requestCustomerRefund(db, flaky, customer, order.id);
      const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id } });
      const [restore, ...scans] = await Promise.allSettled([
        adminRestoreAfterFailedRefund(db, adapter, admin, refund.id, "restaurar"),
        ...tickets.map((t) => checkInTicket(db, owner, event.id, qrPayload(t))),
      ]);
      expect(restore.status).toBe("fulfilled");
      const s = await state(order.id);
      expect(s.order.status).toBe("PAID");
      for (const [j, scan] of scans.entries()) {
        expect(scan.status).toBe("fulfilled");
        const result = (scan as PromiseFulfilledResult<Awaited<ReturnType<typeof checkInTicket>>>).value.result;
        // Ou leu antes da restauração (cancelado) ou depois (entrou); nunca outra coisa.
        expect(["REVOKED", "ADMITTED"]).toContain(result);
        expect(s.tickets.find((t) => t.id === tickets[j].id)!.status).toBe(result === "ADMITTED" ? "CHECKED_IN" : "VALID");
      }
      expect(await checkFinancialInvariants(db)).toEqual([]);
    }
  });

  it("reprocessar × restaurar ao mesmo tempo: nunca estorno E ingressos válidos", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { customer, admin, order } = await setup();
      const { flaky } = scriptedAdapter(["refuse"]);
      const refund = await requestCustomerRefund(db, flaky, customer, order.id);
      await Promise.allSettled([
        adminRetryRefund(db, adapter, admin, refund.id, "reprocessar"),
        adminRestoreAfterFailedRefund(db, adapter, admin, refund.id, "restaurar"),
      ]);
      const s = await state(order.id);
      if (s.order.status === "REFUNDED") {
        expect(s.sim.state).toBe("REFUNDED");
        expect(s.tickets.every((t) => t.status === "REVOKED")).toBe(true);
      } else {
        expect(s.order.status).toBe("PAID");
        expect(s.sim.state).toBe("APPROVED");
        expect(s.tickets.every((t) => t.status === "VALID")).toBe(true);
      }
      expect(await checkFinancialInvariants(db)).toEqual([]);
    }
  });

  it("retentativa bem-sucedida × check-in: o ingresso nunca entra", async () => {
    const { owner, event, customer, order } = await setup();
    const { flaky } = scriptedAdapter(["refuse", "ok"]);
    await requestCustomerRefund(db, flaky, customer, order.id);
    const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id } });
    const [, ...scans] = await Promise.all([
      reconcilePayments(db, flaky, minutesFromNow(6)),
      ...tickets.map((t) => checkInTicket(db, owner, event.id, qrPayload(t))),
    ]);
    expect(scans.every((r) => r.result === "REVOKED")).toBe(true);
    expect((await state(order.id)).order.status).toBe("REFUNDED");
  });
});
