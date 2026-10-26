// Trilha de auditoria somente inserção (gatilho AuditLog_immutable).
import { beforeEach, describe, expect, it } from "vitest";
import { audit } from "@/server/audit";
import { db, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

describe("M — auditoria imutável", () => {
  it("aceita inserção e bloqueia alteração e exclusão", async () => {
    const actor = await makeUser({ admin: true });
    const org = await makeOrg(actor);
    await audit(db, { actorUserId: actor.id, organizationId: org.id, action: "org.approve", entityType: "Organization", entityId: org.id, metadata: { note: "ok" } });
    const entry = await db.auditLog.findFirstOrThrow({ where: { entityId: org.id } });

    await expect(db.auditLog.update({ where: { id: entry.id }, data: { action: "x" } })).rejects.toThrow(/somente inserção/);
    await expect(db.auditLog.updateMany({ data: { metadata: {} } })).rejects.toThrow(/somente inserção/);
    await expect(db.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/somente inserção/);
    await expect(db.auditLog.deleteMany({})).rejects.toThrow(/somente inserção/);
    // O ON DELETE SET NULL da FK também é um UPDATE: o ator não some da trilha.
    await expect(db.user.delete({ where: { id: actor.id } })).rejects.toThrow();

    expect(await db.auditLog.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ action: "org.approve", actorUserId: actor.id });
  });
});
