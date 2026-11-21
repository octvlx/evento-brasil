// Histórico das páginas de detalhe do admin: só a entidade pedida, com a permissão dela.
import { beforeEach, describe, expect, it } from "vitest";
import { entityHistory } from "@/server/services/admin-oversight";
import { setEventSuspended } from "@/server/services/events";
import { setOrganizationSuspended } from "@/server/services/organizers";
import { setUserSuspended } from "@/server/services/users";
import { db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const asRole = async (role: "MODERATION" | "SUPPORT" | "FINANCE") => db.user.update({ where: { id: (await makeUser({ admin: true })).id }, data: { adminRoles: [role] } });

describe("entityHistory", () => {
  it("traz só os registros da entidade, mais recentes primeiro", async () => {
    const admin = await makeUser({ admin: true });
    const org = await makeOrg(await makeUser());
    const [a, b] = [await makeEvent(org), await makeEvent(org)];
    await setEventSuspended(db, admin, a.id, true, "Golpe denunciado");
    await setEventSuspended(db, admin, a.id, false);
    await setEventSuspended(db, admin, b.id, true, "Outro evento");

    const h = await entityHistory(db, admin, "Event", a.id);
    expect(h.total).toBe(2);
    expect(h.items.every((i) => i.entityType === "Event" && i.entityId === a.id)).toBe(true);
    expect(h.items[0].createdAt >= h.items[1].createdAt).toBe(true);
    expect(h.items[0].actor?.email).toBe(admin.email);
  });

  it("exige a permissão da entidade, não audit:read", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org);
    const superAdmin = await makeUser({ admin: true });
    await setOrganizationSuspended(db, superAdmin, org.id, true, "Documentos inválidos");
    await setUserSuspended(db, superAdmin, owner.id, true, "Fraude");

    const moderation = await asRole("MODERATION");
    const support = await asRole("SUPPORT");
    const finance = await asRole("FINANCE");
    expect((await entityHistory(db, moderation, "Event", event.id)).total).toBe(0);
    expect((await entityHistory(db, moderation, "Organization", org.id)).total).toBeGreaterThan(0);
    expect((await entityHistory(db, support, "User", owner.id)).total).toBeGreaterThan(0);
    await expect(entityHistory(db, support, "Event", event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(entityHistory(db, finance, "Organization", org.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(entityHistory(db, moderation, "User", owner.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
