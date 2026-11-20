// Admin: trava no reenvio do cadastro do organizador e tela de pagamentos
// (verificações, pagamentos em análise e listas paginadas).
import { beforeEach, describe, expect, it } from "vitest";
import { reviewOrganization, resubmitOrganizerApplication, submitOrganizerApplication } from "@/server/services/organizers";
import {
  ADMIN_PAGE_SIZE,
  adminFinancialChecks,
  listAdminOrders,
  listAdminRefunds,
  listPaymentsForReview,
  listWebhookEvents,
  parseOrderStatus,
} from "@/server/services/admin-oversight";
import { operationalHealth } from "@/server/services/ops-health";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const application = (name: string) => ({ name, legalType: "COMPANY" as const, legalName: `${name} LTDA`, document: "11.222.333/0001-81", contactEmail: "contato@example.com" });

async function rejectedOrg() {
  const owner = await makeUser();
  const admin = await makeUser({ admin: true });
  const org = await submitOrganizerApplication(db, owner, application("Recusada"));
  await reviewOrganization(db, admin, org.id, "REJECT", "Documento ilegível");
  return { owner, admin, org };
}

describe("reenvio do cadastro do organizador", () => {
  it("dois reenvios ao mesmo tempo: um passa, uma só verificação nova", async () => {
    const { owner, org } = await rejectedOrg();
    const results = await Promise.allSettled([
      resubmitOrganizerApplication(db, owner, org.id, application("Corrigida A")),
      resubmitOrganizerApplication(db, owner, org.id, application("Corrigida B")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "INVALID_STATE" } });
    expect(await db.organizerVerification.count({ where: { organizationId: org.id } })).toBe(2);
    expect(await db.auditLog.count({ where: { action: "organization.resubmitted", entityId: org.id } })).toBe(1);
  });

  it("suspensão em andamento: o reenvio espera e não desfaz a suspensão", async () => {
    const { owner, org } = await rejectedOrg();
    let resubmit!: Promise<unknown>;
    // Uma decisão do admin segura a linha da organização (como lockOrganization) e
    // suspende; o reenvio começa no meio dela. Sem a trava, o reenvio lia REJECTED e
    // gravava PENDING_REVIEW por cima da suspensão depois do commit.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${org.id} FOR UPDATE`;
      await tx.organization.update({ where: { id: org.id }, data: { status: "SUSPENDED", statusReason: "Fraude" } });
      resubmit = resubmitOrganizerApplication(db, owner, org.id, application("Corrigida")).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 500));
    });
    expect(await resubmit).toMatchObject({ code: "FORBIDDEN", message: "Esta organização está suspensa." });
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("SUSPENDED");
    expect(await db.organizerVerification.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it("quem saiu da equipe antes da trava não reenvia", async () => {
    const { owner, org } = await rejectedOrg();
    const other = await makeUser();
    await db.organizationMember.create({ data: { organizationId: org.id, userId: other.id, role: "ADMIN" } });
    await db.organizationMember.delete({ where: { organizationId_userId: { organizationId: org.id, userId: other.id } } });
    await expect(resubmitOrganizerApplication(db, other, org.id, application("Invasor"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(resubmitOrganizerApplication(db, owner, org.id, application("Dono"))).resolves.toMatchObject({ status: "PENDING_REVIEW" });
  });
});

describe("tela de pagamentos do admin", () => {
  it("exige permissão financeira", async () => {
    const support = await db.user.create({ data: { email: "suporte@test.local", name: "Suporte", passwordHash: "x", platformRole: "ADMIN", adminRoles: ["SUPPORT"] } });
    await expect(listAdminOrders(db, support)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminFinancialChecks(db, support)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listPaymentsForReview(db, support)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const finance = await db.user.create({ data: { email: "fin@test.local", name: "Fin", passwordHash: "x", platformRole: "ADMIN", adminRoles: ["FINANCE"] } });
    await expect(listAdminOrders(db, finance)).resolves.toMatchObject({ total: 0 });
  });

  it("pedidos paginados e filtrados por código, e-mail, evento e situação", async () => {
    const admin = await makeUser({ admin: true });
    const event = await makeEvent(await makeOrg(await makeUser()), { capacity: 100, tickets: [{ priceCents: 1000, quantityTotal: 100 }] });
    await db.event.update({ where: { id: event.id }, data: { title: "Festival Paginado" } });
    for (let i = 0; i < ADMIN_PAGE_SIZE + 2; i++) {
      await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    }
    const first = await listAdminOrders(db, admin);
    expect(first).toMatchObject({ total: ADMIN_PAGE_SIZE + 2, page: 1, pageCount: 2 });
    expect(first.items).toHaveLength(ADMIN_PAGE_SIZE);
    const second = await listAdminOrders(db, admin, { page: 2 });
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((o) => o.id)).size).toBe(ADMIN_PAGE_SIZE + 2);
    // Página acima do total cai na última.
    expect((await listAdminOrders(db, admin, { page: 99 })).page).toBe(2);

    const target = first.items[3];
    expect((await listAdminOrders(db, admin, { q: target.publicCode.toLowerCase() })).items.map((o) => o.id)).toEqual([target.id]);
    await db.order.update({ where: { id: target.id }, data: { buyerEmail: "Alguem.Unico@Exemplo.test" } });
    expect((await listAdminOrders(db, admin, { q: "alguem.unico@" })).items.map((o) => o.id)).toEqual([target.id]);
    expect((await listAdminOrders(db, admin, { q: "festival pag" })).total).toBe(ADMIN_PAGE_SIZE + 2);
    expect((await listAdminOrders(db, admin, { status: "REFUNDED" })).total).toBe(0);
    expect((await listAdminOrders(db, admin, { status: "PAID", q: "nada-disso" })).total).toBe(0);
    expect(parseOrderStatus("PAID")).toBe("PAID");
    expect(parseOrderStatus("DROP TABLE")).toBeUndefined();
  });

  it("reembolsos e webhooks paginados; filtro de webhooks pendentes", async () => {
    const admin = await makeUser({ admin: true });
    const now = Date.now();
    for (let i = 0; i < ADMIN_PAGE_SIZE + 1; i++) {
      await db.paymentWebhookEvent.create({
        data: { provider: "simulated", externalEventId: `ev-${i}`, eventType: "payment", payload: {}, receivedAt: new Date(now - i * 1000), processedAt: i % 5 === 0 ? null : new Date() },
      });
    }
    const all = await listWebhookEvents(db, admin);
    expect(all).toMatchObject({ total: ADMIN_PAGE_SIZE + 1, pageCount: 2 });
    expect(all.items[0]).not.toHaveProperty("payload");
    const pending = await listWebhookEvents(db, admin, { pendingOnly: true });
    expect(pending.total).toBe(6);
    expect(pending.items.every((w) => w.processedAt === null)).toBe(true);
    expect(await listAdminRefunds(db, admin)).toMatchObject({ total: 0, page: 1, pageCount: 1, items: [] });
  });

  it("pagamentos em análise incluem a cobrança sem vínculo com o provedor; resolvidos saem", async () => {
    const admin = await makeUser({ admin: true });
    const event = await makeEvent(await makeOrg(await makeUser()));
    const { order } = await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const paid = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const base = { orderId: order.id, provider: "simulated", method: paid.method, amountCents: 100 };
    await db.payment.create({ data: { ...base, idempotencyKey: "pay:sem-vinculo", status: "PENDING", failureReason: "PROVIDER_LINK_MISSING" } });
    await db.payment.create({ data: { ...base, idempotencyKey: "pay:duplicado", providerPaymentId: "dup-1", status: "PAID", failureReason: "DUPLICATE_PAYMENT_REQUIRES_REFUND" } });
    // Já estornado: não exige mais ninguém.
    await db.payment.create({ data: { ...base, idempotencyKey: "pay:resolvido", providerPaymentId: "dup-2", status: "REFUNDED", failureReason: "DUPLICATE_PAYMENT_REQUIRES_REFUND" } });
    const review = await listPaymentsForReview(db, admin);
    expect(review.map((p) => p.idempotencyKey).sort()).toEqual(["pay:duplicado", "pay:sem-vinculo"]);

    const health = await operationalHealth(db);
    expect(health.find((c) => c.code === "PAYMENT_PROVIDER_LINK_MISSING")).toMatchObject({ severity: "warning", count: 1, href: "/admin/pagamentos#pagamentos-em-analise" });
  });

  it("verificações financeiras mostram a divergência", async () => {
    const admin = await makeUser({ admin: true });
    const event = await makeEvent(await makeOrg(await makeUser()));
    const { order } = await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    expect(await adminFinancialChecks(db, admin)).toEqual([]);
    await db.orderItem.updateMany({ where: { orderId: order.id }, data: { commissionPerUnitCents: { increment: 1 } } });
    expect(await adminFinancialChecks(db, admin)).toContainEqual(expect.objectContaining({ code: "ORDER_TOTALS_MISMATCH", ids: [order.id] }));
  });
});
