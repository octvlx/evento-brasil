// Primeiro administrador (npm run admin:promote): só enquanto não houver superadministrador.
import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapFirstAdmin } from "@/server/services/admin-bootstrap";
import { db, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

describe("primeiro administrador", () => {
  it("promove conta confirmada a superadministradora e audita", async () => {
    const u = await makeUser({ verified: true, email: "dona@exemplo.com.br" });
    await bootstrapFirstAdmin(db, "  Dona@Exemplo.com.br ");
    const after = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect([after.platformRole, after.adminRoles]).toEqual(["ADMIN", ["SUPER_ADMIN"]]);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "admin.bootstrap", entityId: u.id } });
    expect(log.actorUserId).toBeNull();
  });

  it("recusa quando já existe superadministrador ativo", async () => {
    await makeUser({ admin: true });
    const u = await makeUser({ verified: true });
    await expect(bootstrapFirstAdmin(db, u.email)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).platformRole).toBe("USER");
  });

  it("recusa conta inexistente, sem e-mail confirmado, demo ou suspensa", async () => {
    await expect(bootstrapFirstAdmin(db, "ninguem@exemplo.com.br")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const unverified = await makeUser();
    await expect(bootstrapFirstAdmin(db, unverified.email)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const demo = await makeUser({ verified: true });
    await db.user.update({ where: { id: demo.id }, data: { isDemoAccount: true } });
    await expect(bootstrapFirstAdmin(db, demo.email)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const suspended = await makeUser({ verified: true });
    await db.user.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });
    await expect(bootstrapFirstAdmin(db, suspended.email)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await db.user.count({ where: { platformRole: "ADMIN" } })).toBe(0);
  });
});
