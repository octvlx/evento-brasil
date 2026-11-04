// T6 — sub-papéis do admin da plataforma: cada ação administrativa exige a
// permissão do papel; SUPER_ADMIN pode tudo; só ele altera papéis (nunca os próprios).
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminRole } from "@/generated/prisma/client";
import { ADMIN_ROLES, adminHas, type AdminPermission } from "@/server/auth/admin-roles";
import { assertAdminPermission, assertPlatformAdmin } from "@/server/auth/permissions";
import { createSession, resolveSession } from "@/server/auth/sessions";
import { listAuditLogs } from "@/server/services/admin-oversight";
import { setCommissionRule } from "@/server/services/commission";
import { reviewOrganization } from "@/server/services/organizers";
import { adminStats } from "@/server/services/reports";
import { setAdminRoles, setUserSuspended } from "@/server/services/users";
import { db, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

let n = 0;
const adminWith = (roles: AdminRole[]) =>
  db.user.create({ data: { email: `admin-${++n}-${Date.now()}@test.local`, name: `Admin ${n}`, passwordHash: "x", platformRole: "ADMIN", adminRoles: roles } });

const commission = { scope: "PLATFORM" as const, percentBps: 800, fixedCentsPerTicket: 0, bearer: "ORGANIZER" as const, processingFeeBearer: "ORGANIZER" as const, refundCommissionOnRefund: true };

describe("mapa de permissões", () => {
  const ALL: AdminPermission[] = ["organizers:review", "events:moderate", "events:cancel", "finance:commissions", "finance:refunds", "cancellations:decide", "transfers:read", "users:manage", "audit:read", "admins:manage", "users:delete"];
  const expected: Record<AdminRole, AdminPermission[]> = {
    SUPER_ADMIN: ALL,
    FINANCE: ["finance:commissions", "finance:refunds", "cancellations:decide"],
    MODERATION: ["organizers:review", "events:moderate", "events:cancel", "transfers:read"],
    SUPPORT: ["users:manage", "transfers:read", "cancellations:decide"],
  };

  it.each(ADMIN_ROLES)("%s tem exatamente as permissões previstas", async (role) => {
    const admin = await adminWith([role]);
    for (const perm of ALL) {
      const allowed = expected[role].includes(perm);
      expect(adminHas(admin.adminRoles, perm)).toBe(allowed);
      if (allowed) expect(() => assertAdminPermission(admin, perm)).not.toThrow();
      else expect(() => assertAdminPermission(admin, perm)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    }
  });

  it("papéis somam permissões; admin sem papel só vê a visão geral", async () => {
    const both = await adminWith(["FINANCE", "SUPPORT"]);
    expect(adminHas(both.adminRoles, "finance:commissions") && adminHas(both.adminRoles, "users:manage")).toBe(true);
    expect(adminHas(both.adminRoles, "organizers:review")).toBe(false);

    const none = await adminWith([]);
    expect(() => assertPlatformAdmin(none)).not.toThrow();
    await expect(adminStats(db, none)).resolves.toBeDefined();
    expect(() => assertAdminPermission(none, "users:manage")).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("quem não é admin continua barrado, mesmo com o papel no objeto", async () => {
    const user = await makeUser();
    expect(() => assertAdminPermission({ ...user, adminRoles: ["SUPER_ADMIN"] }, "users:manage")).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});

describe("serviços reais respeitam o papel", () => {
  it("suporte suspende cliente, mas não mexe em comissão nem lê a auditoria", async () => {
    const support = await adminWith(["SUPPORT"]);
    const customer = await makeUser();
    await setUserSuspended(db, support, customer.id, true, "fraude");
    await expect(setCommissionRule(db, support, commission)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listAuditLogs(db, support)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("financeiro altera comissão, mas não suspende cliente nem aprova organizador", async () => {
    const finance = await adminWith(["FINANCE"]);
    await setCommissionRule(db, finance, commission);
    const customer = await makeUser();
    await expect(setUserSuspended(db, finance, customer.id, true, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const org = await makeOrg(await makeUser(), { status: "PENDING_REVIEW" });
    await expect(reviewOrganization(db, finance, org.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("moderação aprova organizador; super admin faz tudo", async () => {
    const moderation = await adminWith(["MODERATION"]);
    const org = await makeOrg(await makeUser(), { status: "PENDING_REVIEW" });
    await reviewOrganization(db, moderation, org.id, "APPROVE");
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("APPROVED");

    const superAdmin = await makeUser({ admin: true });
    await setCommissionRule(db, superAdmin, commission);
    await expect(listAuditLogs(db, superAdmin)).resolves.toBeDefined();
  });
});

describe("gerenciar papéis (setAdminRoles)", () => {
  it("super admin troca o papel de outro admin; vale já na sessão aberta e fica na auditoria", async () => {
    const superAdmin = await makeUser({ admin: true });
    const target = await adminWith(["SUPPORT"]);
    const session = await createSession(db, target.id);
    await setAdminRoles(db, superAdmin, target.id, ["FINANCE", "MODERATION"]);
    expect((await resolveSession(db, session.token))?.user.adminRoles).toEqual(["FINANCE", "MODERATION"]);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "admin.roles_changed", entityId: target.id } });
    expect(log.actorUserId).toBe(superAdmin.id);
    expect(log.metadata).toEqual({ before: ["SUPPORT"], after: ["FINANCE", "MODERATION"] });
  });

  it("recusa: quem não é super admin, a própria conta, papel inválido, nenhum papel, conta que não é admin", async () => {
    const superAdmin = await makeUser({ admin: true });
    const finance = await adminWith(["FINANCE"]);
    const other = await adminWith(["SUPPORT"]);
    await expect(setAdminRoles(db, finance, other.id, ["SUPER_ADMIN"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setAdminRoles(db, superAdmin, superAdmin.id, ["SUPPORT"])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setAdminRoles(db, superAdmin, other.id, ["DONO_DE_TUDO"])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setAdminRoles(db, superAdmin, other.id, [])).rejects.toMatchObject({ code: "VALIDATION" });
    const customer = await makeUser();
    await expect(setAdminRoles(db, superAdmin, customer.id, ["SUPPORT"])).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await db.auditLog.count({ where: { action: "admin.roles_changed" } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).adminRoles).toEqual(["SUPPORT"]);
  });

  it("o banco recusa papel de admin em conta que não é admin", async () => {
    const customer = await makeUser();
    await expect(db.user.update({ where: { id: customer.id }, data: { adminRoles: ["SUPER_ADMIN"] } })).rejects.toThrow();
  });
});
