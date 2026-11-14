// Saúde operacional e alertas: webhooks parados, reembolsos aguardando o admin,
// pagamentos para reembolso manual, e-mails com falha; e-mail de alerta deduplicado.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ALERT_EMAILS = "ops@example.com, Financeiro@Example.com, invalido";
});

import type { PaymentProviderAdapter, RefundResult } from "@/server/payments/types";
import { ALERT_REPEAT_HOURS, alertRecipients, operationalHealth, raiseOperationalAlerts } from "@/server/services/ops-health";
import { requestCustomerRefund } from "@/server/services/refunds";
import { reconcilePayments } from "@/server/services/reconciliation";
import { GET } from "@/app/api/cron/health/route";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
const codes = async () => (await operationalHealth(db)).map((c) => c.code);

const refusingAdapter = Object.assign(Object.create(adapter) as PaymentProviderAdapter, {
  async refundPayment(input: { providerPaymentId: string }): Promise<RefundResult> {
    return { providerRefundId: `sim-refund-${input.providerPaymentId}`, status: "FAILED" };
  },
});

async function paidOrder() {
  const owner = await makeUser();
  const event = await makeEvent(await makeOrg(owner), { startsInDays: 20, tickets: [{ priceCents: 5000, quantityTotal: 10 }] });
  const buyer = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  return { buyer, order };
}

function webhook(receivedAt: Date, processedAt: Date | null = null) {
  return db.paymentWebhookEvent.create({
    data: { provider: "simulated", externalEventId: `ev-${receivedAt.getTime()}-${Math.random()}`, eventType: "payment", payload: {}, receivedAt, processedAt },
  });
}

describe("operationalHealth", () => {
  it("sem problemas devolve lista vazia", async () => {
    await paidOrder();
    expect(await operationalHealth(db)).toEqual([]);
  });

  it("webhook sem processar só conta depois de 15 min", async () => {
    await webhook(minutesAgo(5));
    await webhook(minutesAgo(40), minutesAgo(39));
    expect(await codes()).toEqual([]);
    const old = await webhook(minutesAgo(20));
    const [check] = await operationalHealth(db);
    expect(check).toMatchObject({ code: "WEBHOOK_STUCK", severity: "critical", count: 1, oldestAt: old.receivedAt });
  });

  it("reembolso com falha só alerta quando acabam as tentativas automáticas", async () => {
    const { buyer, order } = await paidOrder();
    await requestCustomerRefund(db, refusingAdapter, buyer, order.id);
    expect(await codes()).not.toContain("REFUND_AWAITING_ADMIN");
    for (const m of [6, 40, 3 * 60]) await reconcilePayments(db, refusingAdapter, new Date(Date.now() + m * 60_000));
    expect(await codes()).toContain("REFUND_AWAITING_ADMIN");
  });

  it("pagamento sinalizado para reembolso manual, reembolso preso e e-mail com falha", async () => {
    const { order } = await paidOrder();
    await db.payment.updateMany({ where: { orderId: order.id }, data: { failureReason: "DUPLICATE_PAYMENT_REQUIRES_REFUND" } });
    await db.emailOutbox.create({ data: { dedupeKey: "x", template: "T", recipient: "a@b.c", status: "FAILED" } });
    const checks = await operationalHealth(db);
    expect(checks.map((c) => [c.code, c.severity])).toEqual(
      expect.arrayContaining([
        ["PAYMENT_NEEDS_MANUAL_REFUND", "critical"],
        ["EMAIL_DELIVERY_FAILED", "warning"],
      ]),
    );
  });

  it("violações de invariantes vindas do cron entram como críticas", async () => {
    const [check] = await operationalHealth(db, new Date(), [{ code: "X", ids: ["a", "b"] }]);
    expect(check).toMatchObject({ code: "INVARIANT_VIOLATION", count: 2, severity: "critical" });
  });
});

describe("raiseOperationalAlerts", () => {
  it("só endereços válidos, normalizados", () => {
    expect(alertRecipients()).toEqual(["ops@example.com", "financeiro@example.com"]);
  });

  it("enfileira um e-mail por problema e destinatário, sem repetir na mesma janela", async () => {
    await webhook(minutesAgo(30));
    const now = new Date();
    const checks = await operationalHealth(db, now);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await raiseOperationalAlerts(db, checks, now)).toEqual({ problems: 1, queued: 2 });
    expect(log.mock.calls[0][0]).toMatch(/^\[alerta\] \{.*"event":"WEBHOOK_STUCK"/);
    log.mockRestore();
    const jobs = await db.emailOutbox.findMany({ where: { template: "OPS_ALERT" } });
    expect(jobs.map((j) => j.recipient).sort()).toEqual(["financeiro@example.com", "ops@example.com"]);
    expect(jobs.every((j) => j.expiresAt && j.expiresAt > now)).toBe(true);

    // Mesma janela: nada novo. Próxima janela, enquanto o problema persiste: avisa de novo.
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await raiseOperationalAlerts(db, checks, new Date(now.getTime() + 60_000))).queued).toBe(0);
    expect((await raiseOperationalAlerts(db, checks, new Date(now.getTime() + ALERT_REPEAT_HOURS * 3_600_000))).queued).toBe(2);
    vi.restoreAllMocks();
  });
});

describe("GET /api/cron/health", () => {
  const get = (secret?: string) => GET(new Request("http://localhost/api/cron/health", { headers: secret ? { "x-cron-secret": secret } : {} }));

  it("exige o segredo; 200 sem problema crítico e 503 com", async () => {
    expect((await get()).status).toBe(403);
    expect((await get("errado")).status).toBe(403);
    const ok = await get(process.env.CRON_SECRET);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, problems: [] });
    await webhook(minutesAgo(30));
    const bad = await get(process.env.CRON_SECRET);
    expect(bad.status).toBe(503);
    expect(await bad.json()).toMatchObject({ ok: false, problems: [{ code: "WEBHOOK_STUCK", count: 1 }] });
  });
});
