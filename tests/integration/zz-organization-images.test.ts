// Logo e capa da organização: upload validado, permissão, remoção e perfil público.
import { beforeEach, describe, expect, it } from "vitest";
import { setOrganizationImage } from "@/server/services/organizers";
import { getPublicOrganizer } from "@/server/services/catalog";
import { db, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

/** PNG mínimo com o cabeçalho IHDR nas dimensões pedidas (só o cabeçalho é lido). */
function png(width: number, height: number) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return new File([b], "imagem.png", { type: "image/png" });
}

async function setup() {
  const owner = await makeUser();
  const finance = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: finance.id, role: "FINANCE" }] });
  return { owner, finance, org };
}

describe("setOrganizationImage", () => {
  it("grava logo e capa como URLs do armazenamento e audita", async () => {
    const { owner, org } = await setup();
    const a = await setOrganizationImage(db, owner, org.id, "logo", png(400, 400));
    const b = await setOrganizationImage(db, owner, org.id, "cover", png(1600, 400));
    expect(a.logoUrl).toMatch(new RegExp(`^/uploads/events/${org.id}/[^/]+\.png$`));
    expect(b).toMatchObject({ logoUrl: a.logoUrl, coverUrl: expect.stringMatching(/\.png$/) });
    const actions = (await db.auditLog.findMany({ where: { entityId: org.id }, select: { action: true } })).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["organization.logo_updated", "organization.cover_updated"]));
  });

  it("recusa imagem pequena, arquivo que não é imagem e acima de 5 MB", async () => {
    const { owner, org } = await setup();
    await expect(setOrganizationImage(db, owner, org.id, "logo", png(100, 100))).rejects.toThrow(/200 × 200/);
    await expect(setOrganizationImage(db, owner, org.id, "cover", png(800, 600))).rejects.toThrow(/1200 × 300/);
    await expect(setOrganizationImage(db, owner, org.id, "logo", new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }))).rejects.toMatchObject({ code: "VALIDATION" });
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    await expect(setOrganizationImage(db, owner, org.id, "logo", big)).rejects.toThrow(/5 MB/);
    expect(await db.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ logoUrl: null, coverUrl: null });
  });

  it("remove com null; exige org:manage", async () => {
    const { owner, finance, org } = await setup();
    await setOrganizationImage(db, owner, org.id, "logo", png(300, 300));
    await expect(setOrganizationImage(db, finance, org.id, "logo", null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setOrganizationImage(db, await makeUser(), org.id, "cover", png(1600, 400))).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    expect((await setOrganizationImage(db, owner, org.id, "logo", null)).logoUrl).toBeNull();
    expect(await db.auditLog.count({ where: { entityId: org.id, action: "organization.logo_removed" } })).toBe(1);
  });

  it("perfil público expõe logo e capa", async () => {
    const { owner, org } = await setup();
    await setOrganizationImage(db, owner, org.id, "logo", png(300, 300));
    const pub = await getPublicOrganizer(db, org.slug);
    expect(pub?.org).toMatchObject({ logoUrl: expect.stringMatching(/^\/uploads\//), coverUrl: null });
  });
});
