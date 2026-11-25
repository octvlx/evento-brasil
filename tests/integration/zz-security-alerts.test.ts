// Alertas de segurança: eventos do AuditLog e reembolsos fora do padrão viram e-mail
// para ALERT_EMAILS, no máximo um por tipo e hora, sem dados pessoais.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ALERT_EMAILS = "seguranca@example.com";
});

import { audit } from "@/server/audit";
import { decryptPII } from "@/server/crypto";
import { LOGIN_LIMITS, recordLoginFailure } from "@/server/auth/login-limits";
import { adminRefundOrder, requestCustomerRefund } from "@/server/services/refunds";
import { cancelEvent } from "@/server/services/cancellation";
import { raiseSecurityAlerts, securityAlerts, securityWindowStart, SECURITY_THRESHOLDS } from "@/server/services/security-alerts";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const codes = async (now = new Date(), t = SECURITY_THRESHOLDS) => (await securityAlerts(db, now, t)).map((c) => c.code).sort();
let ipN = 0;
const ip = () => `198.51.100.${++ipN % 250}`;

async function paidOrder(priceCents = 5000, quantity = 1) {
  const owner = await makeUser();
  const event = await makeEvent(await makeOrg(owner), { startsInDays: 30, tickets: [{ priceCents, quantityTotal: 50 }] });
  const buyer = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity }]);
  return { owner, buyer, event, order };
}

describe("securityAlerts: AuditLog", () => {
  it("nada aconteceu: lista vazia", async () => {
    await paidOrder();
    expect(await securityAlerts(db)).toEqual([]);
  });

  it("2FA travado e papéis de admin são críticos; só conta a hora corrente", async () => {
    const user = await makeUser();
    const now = new Date();
    const lastHour = new Date(securityWindowStart(now).getTime() - 60_000);
    await db.auditLog.create({ data: { action: "mfa.user_locked", entityType: "User", entityId: user.id, createdAt: lastHour } });
    expect(await codes(now)).toEqual([]);
    await audit(db, { actorUserId: user.id, action: "mfa.user_locked", entityType: "User", entityId: user.id });
    await audit(db, { action: "admin.roles_changed", entityType: "User", entityId: user.id });
    const checks = await securityAlerts(db);
    expect(checks.map((c) => [c.code, c.severity, c.count])).toEqual([
      ["MFA_USER_LOCKED", "critical", 1],
      ["ADMIN_ROLES_CHANGED", "critical", 1],
    ]);
  });

  it("ações administrativas sensíveis somam num só alerta", async () => {
    const user = await makeUser();
    for (const action of ["mfa.reset_by_admin", "commission_rule.updated", "user.deleted_by_admin"]) await audit(db, { action, entityType: "User", entityId: user.id });
    await audit(db, { action: "user.password_changed", entityType: "User", entityId: user.id });
    const [check] = await securityAlerts(db);
    expect(check).toMatchObject({ code: "ADMIN_SENSITIVE_ACTION", severity: "warning", count: 3 });
  });
});

describe("bloqueio de conta no login vira auditoria e alerta", () => {
  const locks = () => db.auditLog.findMany({ where: { action: "auth.login_locked" } });

  it("audita uma vez, na falha que bloqueia, sem o IP nem a senha", async () => {
    const user = await makeUser();
    for (let i = 0; i < LOGIN_LIMITS.account.max - 1; i++) await recordLoginFailure(ip(), user.email, db);
    expect(await locks()).toHaveLength(0);
    const from = ip();
    await recordLoginFailure(from, user.email, db);
    await recordLoginFailure(ip(), user.email, db);
    const rows = await locks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "User", entityId: user.id });
    expect(JSON.stringify(rows[0])).not.toContain(from);
    expect(await codes()).toEqual(["ACCOUNT_LOGIN_LOCKED"]);
  });

  it("e-mail sem conta não grava nada (nem o e-mail digitado)", async () => {
    for (let i = 0; i < LOGIN_LIMITS.account.max; i++) await recordLoginFailure(ip(), "ninguem@example.com", db);
    expect(await locks()).toHaveLength(0);
    expect(await codes()).toEqual([]);
  });

  it("conta suspensa também é auditada (sem aviso ao titular)", async () => {
    const user = await makeUser();
    await db.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    for (let i = 0; i < LOGIN_LIMITS.account.max; i++) await recordLoginFailure(ip(), user.email, db);
    expect(await locks()).toHaveLength(1);
    expect(await db.emailOutbox.count({ where: { template: "ACCOUNT_LOGIN_LOCKED" } })).toBe(0);
  });
});

describe("securityAlerts: reembolsos fora do padrão", () => {
  it("pedido comum de reembolso do comprador não alerta", async () => {
    const { buyer, order } = await paidOrder();
    await requestCustomerRefund(db, adapter, buyer, order.id);
    expect(await codes()).toEqual([]);
  });

  it("reembolso de valor alto alerta", async () => {
    const { buyer, order } = await paidOrder(250_000);
    await requestCustomerRefund(db, adapter, buyer, order.id);
    expect(await codes()).toEqual(["REFUND_LARGE"]);
  });

  it("reembolso manual do admin alerta", async () => {
    const { order } = await paidOrder();
    const admin = await makeUser({ admin: true });
    await adminRefundOrder(db, adapter, admin, order.id, "pedido por telefone");
    expect(await codes()).toEqual(["REFUND_BY_ADMIN"]);
  });

  it("volume na mesma hora alerta; cancelamento de evento não conta", async () => {
    const low = { ...SECURITY_THRESHOLDS, refundSpikeCount: 2 };
    const a = await paidOrder();
    await requestCustomerRefund(db, adapter, a.buyer, a.order.id);
    expect(await codes(new Date(), low)).toEqual([]);
    const b = await paidOrder();
    await requestCustomerRefund(db, adapter, b.buyer, b.order.id);
    const spike = (await securityAlerts(db, new Date(), low)).find((c) => c.code === "REFUND_SPIKE");
    expect(spike).toMatchObject({ severity: "critical", count: 2 });

    await resetDb();
    const c = await paidOrder(5000, 3);
    await cancelEvent(db, adapter, c.owner, c.event.id, "chuva forte");
    expect(await db.refund.count()).toBeGreaterThan(0);
    expect(await codes(new Date(), { ...low, refundSpikeCount: 1 })).toEqual([]);
  });
});

describe("raiseSecurityAlerts", () => {
  it("um e-mail por tipo e hora, sem dado pessoal; nova hora avisa de novo", async () => {
    const user = await makeUser({ email: "vitima@example.com" });
    await audit(db, { action: "mfa.user_locked", entityType: "User", entityId: user.id });
    const now = new Date();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await raiseSecurityAlerts(db, await securityAlerts(db, now), now)).toEqual({ problems: 1, queued: 1 });
    expect(log.mock.calls[0][0]).toMatch(/^\[seguranca\] \{.*"event":"MFA_USER_LOCKED"/);
    await audit(db, { action: "mfa.user_locked", entityType: "User", entityId: user.id });
    expect(await raiseSecurityAlerts(db, await securityAlerts(db, now), now)).toEqual({ problems: 1, queued: 0 });

    const [job] = await db.emailOutbox.findMany({ where: { template: "SECURITY_ALERT" } });
    expect(job.recipient).toBe("seguranca@example.com");
    const content = decryptPII(job.messageEncrypted!);
    expect(JSON.parse(content).subject).toContain("[ALERTA]");
    expect(content).not.toContain("vitima@example.com");
    expect(content).not.toContain(user.id);
    expect(job.expiresAt!.getTime()).toBe(securityWindowStart(now).getTime() + 3_600_000);

    const nextHour = new Date(securityWindowStart(now).getTime() + 3_600_000 + 1000);
    await db.auditLog.create({ data: { action: "mfa.user_locked", entityType: "User", entityId: user.id, createdAt: nextHour } });
    expect(await raiseSecurityAlerts(db, await securityAlerts(db, nextHour), nextHour)).toMatchObject({ queued: 1 });
    // O alerta operacional segue com a janela e o texto dele.
    expect(await db.emailOutbox.count({ where: { template: "OPS_ALERT" } })).toBe(0);
  });
});
