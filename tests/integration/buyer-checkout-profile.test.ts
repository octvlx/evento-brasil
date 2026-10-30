import { beforeEach, describe, expect, it } from "vitest";
import { db, makeUser, resetDb } from "../support/fixtures";
import { getBuyerCheckoutProfile, saveBuyerAddress, saveBuyerPersonalData } from "@/server/services/buyer-profile";
import { decryptPII } from "@/server/crypto";

beforeEach(resetDb);
const personal = { name: "Pessoa Compradora", cpf: "529.982.247-25", birthDate: "1995-04-15" };
const address = { postalCode: "01001-000", street: "Praça da Sé", number: "123", complement: "Apto 2", district: "Sé", city: "São Paulo", state: "SP" };

describe("buyer identity and reusable checkout address", () => {
  it("starts without an address and saves encrypted identity with only masked CPF exposed", async () => {
    const user = await makeUser();
    expect(await getBuyerCheckoutProfile(db, user)).toMatchObject({ address: null, personalComplete: false, cpfMasked: null });
    const profile = await saveBuyerPersonalData(db, user, personal);
    expect(profile).toMatchObject({ cpfMasked: "***.***.***-25", birthDate: "1995-04-15", personalComplete: true });
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(decryptPII(stored.cpfEncrypted!)).toBe("52998224725");
    expect(JSON.stringify(profile)).not.toContain("52998224725");
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain("52998224725");
  });
  it("keeps CPF immutable and unique while allowing name and birth date corrections", async () => {
    const user = await makeUser();
    await saveBuyerPersonalData(db, user, personal);
    await expect(saveBuyerPersonalData(db, user, { ...personal, cpf: "16899535009" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(saveBuyerPersonalData(db, await makeUser(), personal)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await saveBuyerPersonalData(db, user, { name: "Nome Corrigido", birthDate: "1994-04-15" })).toMatchObject({ name: "Nome Corrigido", birthDate: "1994-04-15", cpfMasked: "***.***.***-25" });
  });
  it("reuses one address across purchases, allows clearing complement, and isolates users", async () => {
    const user = await makeUser(); const other = await makeUser();
    await saveBuyerAddress(db, user, address);
    expect((await getBuyerCheckoutProfile(db, user)).address).toMatchObject({ postalCode: "01001000", number: "123", complement: "Apto 2" });
    expect((await getBuyerCheckoutProfile(db, other)).address).toBeNull();
    await saveBuyerAddress(db, user, { ...address, number: "456", complement: "" });
    expect(await db.userAddress.count()).toBe(1);
    expect((await getBuyerCheckoutProfile(db, user)).address).toMatchObject({ number: "456", complement: "" });
  });
  it("validates personal/address fields server-side and refuses suspended actors", async () => {
    const user = await makeUser();
    await expect(saveBuyerPersonalData(db, user, { ...personal, birthDate: "2099-01-01" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveBuyerPersonalData(db, user, { ...personal, birthDate: "1995-02-30" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveBuyerAddress(db, user, { ...address, postalCode: "bad" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveBuyerAddress(db, { ...user, status: "SUSPENDED" }, address)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
