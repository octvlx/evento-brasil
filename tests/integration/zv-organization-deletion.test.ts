// Exclusão de conta de organizador (organização) com Postgres real: exclusão lógica pelo
// superadmin, bloqueios por vendas ativas, pedido do responsável (aprovar, recusar,
// cancelar), auditoria e preservação do histórico financeiro.
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminRole } from "@/generated/prisma/client";
import { hashPassword } from "@/server/auth/password";
import { totpCode, totpStep } from "@/server/auth/totp";
import { DELETED_ORG_REASON, deletedOrgSlug } from "@/lib/organization-deletion";
import {
  adminDeleteOrganization,
  cancelOrganizationDeletionRequest,
  latestOrganizationDeletionRequest,
  organizationDeletionBlockers,
  rejectOrganizationDeletionRequest,
  requestOrganizationDeletion,
} from "@/server/services/organization-deletion";
import { setOrganizationSuspended } from "@/server/services/organizers";
import { confirmTotpEnrollment, startTotpEnrollment } from "@/server/services/two-factor";
import { makeBuyerReady } from "../support/buyer-ready";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

const DAY = 86_400_000;
const PASSWORD = "senha-forte-1";
const REASON = "Pedido do responsável pelo SAC";

beforeEach(resetDb);

const T0 = new Date();
let tick = 0;
const next = () => new Date(T0.getTime() + ++tick * 30_000);

async function adminWith(roles: AdminRole[] = ["SUPER_ADMIN"]) {
  const created = await makeUser({ admin: true });
  await db.user.update({ where: { id: created.id }, data: { adminRoles: roles } });
  const { secret } = await startTotpEnrollment(db, created.id, T0);
  await confirmTotpEnrollment(db, created.id, totpCode(secret, totpStep(T0)), null, T0);
  const user = await db.user.findUniqueOrThrow({ where: { id: created.id } });
  return { user, code: (when: Date) => totpCode(secret, totpStep(when)) };
}

async function ownerWithOrg() {
  const owner = await db.user.update({ where: { id: (await makeUser()).id }, data: { passwordHash: await hashPassword(PASSWORD) } });
  const staff = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: staff.id, role: "EVENT_MANAGER" }] });
  return { owner, staff, org };
}

async function endEvent(eventId: string) {
  const endsAt = new Date(Date.now() - DAY);
  const startsAt = new Date(endsAt.getTime() - 4 * 3_600_000);
  await db.event.update({ where: { id: eventId }, data: { salesStartAt: new Date(startsAt.getTime() - 30 * DAY), salesEndAt: startsAt, startsAt, endsAt } });
}

function del(admin: Awaited<ReturnType<typeof adminWith>>, org: { id: string; name: string }, extra: { requestId?: string; confirmName?: string } = {}) {
  const when = next();
  return adminDeleteOrganization(db, admin.user, org.id, { confirmName: org.name, reason: REASON, adminCode: admin.code(when), ...extra }, when);
}

describe("exclusão direta pelo superadmin", () => {
  it("só SUPER_ADMIN; outros papéis não mudam nada", async () => {
    const { org } = await ownerWithOrg();
    for (const role of ["FINANCE", "MODERATION", "SUPPORT"] as const) {
      await expect(del(await adminWith([role]), org)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).deletedAt).toBeNull();
  });

  it("com venda ativa (ingresso válido de evento futuro) é bloqueada, auditada, e nada muda", async () => {
    const superAdmin = await adminWith();
    const { org } = await ownerWithOrg();
    const event = await makeEvent(org);
    await buyAndPay(await makeBuyerReady(await makeUser()), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);

    expect(await organizationDeletionBlockers(db, org.id)).toEqual(expect.arrayContaining(["ACTIVE_EVENTS", "VALID_TICKETS", "PAID_ORDERS_UPCOMING"]));
    await expect(del(superAdmin, org)).rejects.toThrow(/não pode ser excluída agora[\s\S]*ingressos válidos/);
    const after = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(after).toMatchObject({ status: "APPROVED", deletedAt: null, slug: org.slug });
    expect(await db.organizationMember.count({ where: { organizationId: org.id } })).toBe(2);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "organization.deletion_blocked", entityId: org.id } });
    expect(log.metadata).toMatchObject({ result: "BLOCKED" });
  });

  it("com histórico encerrado: exclusão lógica que preserva pedidos, razão e auditoria; encerra equipe e Mercado Pago", async () => {
    const superAdmin = await adminWith();
    const { owner, staff, org } = await ownerWithOrg();
    const event = await makeEvent(org);
    const draft = await makeEvent(org, { status: "DRAFT" });
    const { order } = await buyAndPay(await makeBuyerReady(await makeUser()), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await endEvent(event.id);
    await db.organizationInvitation.create({
      data: { organizationId: org.id, email: "convite@test.local", role: "FINANCE", tokenHash: "hash-" + org.id, invitedById: owner.id, expiresAt: new Date(Date.now() + DAY) },
    });
    await db.mercadoPagoAccount.create({
      data: { organizationId: org.id, mercadoPagoUserId: "123", accessTokenEncrypted: "enc-a", refreshTokenEncrypted: "enc-r", tokenExpiresAt: new Date(Date.now() + DAY) },
    });
    const ledgerBefore = await db.financialLedgerEntry.count({ where: { organizationId: org.id } });
    expect(ledgerBefore).toBeGreaterThan(0);
    expect(await organizationDeletionBlockers(db, org.id)).toEqual([]);

    // Confirmação pelo nome: "EXCLUIR" ou nome errado não servem.
    await expect(del(superAdmin, org, { confirmName: "EXCLUIR" })).rejects.toMatchObject({ code: "VALIDATION" });

    const result = await del(superAdmin, { id: org.id, name: `  ${org.name.toUpperCase()} ` });
    expect(result).toMatchObject({ archivedEvents: 1, removedMembers: 2, revokedInvitations: 1, mercadoPagoDisconnected: true });

    const after = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(after).toMatchObject({
      status: "SUSPENDED",
      statusReason: DELETED_ORG_REASON,
      slug: deletedOrgSlug(org.id),
      name: org.name,
      description: null,
      logoUrl: null,
      paymentAccountStatus: "DISABLED",
      autoPublishEvents: false,
    });
    expect(after.deletedAt).not.toBeNull();
    expect(after.contactEmail).not.toBe(org.contactEmail);
    // Equipe e acesso encerrados; contas das pessoas continuam.
    expect(await db.organizationMember.count({ where: { organizationId: org.id } })).toBe(0);
    expect(await db.user.count({ where: { id: { in: [owner.id, staff.id] }, anonymizedAt: null } })).toBe(2);
    expect((await db.organizationInvitation.findFirstOrThrow({ where: { organizationId: org.id } })).revokedAt).not.toBeNull();
    const mp = await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(mp).toMatchObject({ accessTokenEncrypted: "", refreshTokenEncrypted: "" });
    expect(mp.revokedAt).not.toBeNull();
    // Eventos fora da vitrine; o que vendeu fica como prova.
    expect(await db.event.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "ARCHIVED", isUnlisted: true });
    expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ status: "COMPLETED", isUnlisted: true });
    // Financeiro intacto.
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID", totalCents: order.totalCents, organizationId: org.id });
    expect(await db.financialLedgerEntry.count({ where: { organizationId: org.id } })).toBe(ledgerBefore);
    // Auditoria e aviso ao responsável.
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "organization.deleted", entityId: org.id } });
    expect(log.actorUserId).toBe(superAdmin.user.id);
    expect(log.metadata).toMatchObject({ result: "DELETED", reason: REASON });
    expect(await db.emailOutbox.count({ where: { template: "ORGANIZATION_DELETED", recipient: owner.email.toLowerCase() } })).toBe(1);

    // Não reativa nem exclui de novo.
    await expect(setOrganizationSuspended(db, superAdmin.user, org.id, false)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(del(superAdmin, org)).rejects.toThrow(/já foi excluída/);
  });
});

describe("pedido do responsável", () => {
  it("dono pede; membro sem ser dono não; pedido pendente visível e cancelável", async () => {
    const { owner, staff, org } = await ownerWithOrg();
    await expect(requestOrganizationDeletion(db, staff, org.id, { password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requestOrganizationDeletion(db, owner, org.id, { password: "errada" })).rejects.toThrow(/Senha incorreta/);

    await requestOrganizationDeletion(db, owner, org.id, { password: PASSWORD, reason: "Encerramos as atividades" });
    expect(await latestOrganizationDeletionRequest(db, owner, org.id)).toMatchObject({ status: "PENDING", reason: "Encerramos as atividades" });
    await expect(requestOrganizationDeletion(db, owner, org.id, { password: PASSWORD })).rejects.toMatchObject({ code: "INVALID_STATE" });
    // Nada mudou na organização com o pedido.
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("APPROVED");

    await cancelOrganizationDeletionRequest(db, owner, org.id);
    expect(await latestOrganizationDeletionRequest(db, owner, org.id)).toMatchObject({ status: "CANCELLED" });
    expect(await db.auditLog.count({ where: { organizationId: org.id, action: { startsWith: "organization.deletion_request" } } })).toBe(2);
  });

  it("organização com evento à venda não consegue pedir", async () => {
    const { owner, org } = await ownerWithOrg();
    await makeEvent(org);
    await expect(requestOrganizationDeletion(db, owner, org.id, { password: PASSWORD })).rejects.toThrow(/Ainda não dá para pedir[\s\S]*eventos publicados/);
    expect(await db.organizationDeletionRequest.count()).toBe(0);
  });

  it("superadmin recusa: o pedido fica recusado com o motivo e a organização segue ativa", async () => {
    const superAdmin = await adminWith();
    const { owner, org } = await ownerWithOrg();
    const req = await requestOrganizationDeletion(db, owner, org.id, { password: PASSWORD });
    await rejectOrganizationDeletionRequest(db, superAdmin.user, req.id, "Há nota fiscal pendente");
    expect(await latestOrganizationDeletionRequest(db, owner, org.id)).toMatchObject({ status: "REJECTED", decisionNote: "Há nota fiscal pendente" });
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).deletedAt).toBeNull();
    await expect(cancelOrganizationDeletionRequest(db, owner, org.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(del(superAdmin, org, { requestId: req.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("superadmin aprova: a aprovação executa a exclusão e marca o pedido como aprovado", async () => {
    const superAdmin = await adminWith();
    const { owner, org } = await ownerWithOrg();
    const req = await requestOrganizationDeletion(db, owner, org.id, { password: PASSWORD });
    await del(superAdmin, org, { requestId: req.id });
    expect(await db.organizationDeletionRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ status: "APPROVED", decidedById: superAdmin.user.id });
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).deletedAt).not.toBeNull();
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "organization.deleted", entityId: org.id } });
    expect(log.metadata).toMatchObject({ requestId: req.id, approvedRequests: [req.id] });
  });
});
