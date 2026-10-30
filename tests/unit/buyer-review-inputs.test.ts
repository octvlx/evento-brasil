import { describe, expect, it } from "vitest";
import { buyerPersonalSchema, buyerAddressSchema } from "@/features/buyer/schemas";
import { acceptedCartEntries, clearPurchasedSelection, decodeCartField, persistAcceptedCartSelection } from "@/features/orders/cart-storage";

describe("buyer checkout inputs", () => {
  it("validates CPF and civil birth dates without inventing an adult-only rule", () => {
    expect(buyerPersonalSchema.parse({ name: "Pessoa Teste", cpf: "529.982.247-25", birthDate: "2015-04-15" }).cpf).toBe("52998224725");
    for (const birthDate of ["2025-02-29", "2999-01-01", "2026-13-01"]) expect(buyerPersonalSchema.safeParse({ name: "Pessoa Teste", birthDate }).success).toBe(false);
    expect(buyerPersonalSchema.safeParse({ name: "Pessoa Teste", cpf: "11111111111", birthDate: "1995-04-15" }).success).toBe(false);
  });
  it("matches the database birth-date lower boundary with a field-validation message", () => {
    expect(buyerPersonalSchema.safeParse({ name: "Pessoa Teste", birthDate: "1900-01-01" }).success).toBe(true);
    const earlier = buyerPersonalSchema.safeParse({ name: "Pessoa Teste", birthDate: "1899-12-31" });
    expect(earlier.success).toBe(false);
    if (!earlier.success) expect(earlier.error.issues).toContainEqual(expect.objectContaining({ path: ["birthDate"], message: "A data de nascimento deve ser igual ou posterior a 01/01/1900" }));
  });
  it("supports manual addresses when CEP lookup is unavailable and normalizes CEP", () => {
    const address = { postalCode: "01001-000", street: "Praça da Sé", number: "s/n", complement: "", district: "Sé", city: "São Paulo", state: "SP" };
    expect(buyerAddressSchema.parse(address)).toMatchObject({ postalCode: "01001000", number: "s/n", complement: undefined });
    expect(buyerAddressSchema.safeParse({ ...address, number: "" }).success).toBe(false);
    expect(buyerAddressSchema.safeParse({ ...address, state: "XX" }).success).toBe(false);
  });
});
describe("durable buyer cart", () => {
  it("syncs accepted ticket edits without buyer data and keeps the original checkout key", () => {
    const key = "a387a1bf-7965-4979-ac3e-7209a882e10a";
    const entries = acceptedCartEntries({ eventId: "event", items: [{ ticketTypeId: "ticket", quantity: 2 }], buyerName: "Private Buyer", buyerEmail: "private@example.test", couponCode: "PROMO10", halfPriceDeclaration: true, idempotencyKey: key });
    expect(entries).not.toBeNull();
    const values = new Map<string, string>();
    expect(persistAcceptedCartSelection({ setItem: (name, value) => { values.set(name, value); } }, entries!)).toBe(true);
    expect(decodeCartField("quantities", values.get("eb-cart:event:quantities") ?? null, {})).toEqual({ ticket: 2 });
    expect(JSON.parse(values.get("eb-cart:event:coupon")!)).toBe("PROMO10");
    expect(JSON.parse(values.get("eb-cart:event:idempotencyKey")!)).toBe(key);
    expect(JSON.stringify([...values])).not.toMatch(/Private Buyer|private@example/);
    expect(persistAcceptedCartSelection({ setItem: () => { throw new Error("storage unavailable"); } }, entries!)).toBe(false);
  });
  it("restores valid quantities and rejects malformed or unbounded browser storage", () => {
    expect(decodeCartField("quantities", '{"ticket":2}', {})).toEqual({ ticket: 2 });
    for (const raw of ['{"ticket":-1}', '{"ticket":1000000}', '{"ticket":"2"}', 'broken']) expect(decodeCartField("quantities", raw, {})).toEqual({});
  });
  it("clears a completed cart for a second purchase while preserving a newer selection", () => {
    const oldKey = "a387a1bf-7965-4979-ac3e-7209a882e10a"; const newKey = "78d8aee9-9fae-4ed7-875c-97b66149010d";
    const values = new Map([["eb-cart:event:idempotencyKey", JSON.stringify(newKey)], ["eb-cart:event:quantities", '{"ticket":2}']]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
    expect(clearPurchasedSelection(storage, "event", oldKey)).toBe(false); expect(values.size).toBe(2);
    expect(clearPurchasedSelection(storage, "event", newKey)).toBe(true); expect(values.size).toBe(0);
  });
});
