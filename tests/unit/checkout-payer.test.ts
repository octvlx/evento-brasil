import { describe, expect, it } from "vitest";
import { payerDetailsSchema } from "@/features/orders/payer-details";

describe("provider-specific checkout information", () => {
  it("strips unsolicited data when no extra fields are required", () => {
    expect(payerDetailsSchema({}).parse({ document: { type: "CPF", number: "52998224725" }, cardNumber: "not-accepted" })).toEqual({});
  });
  it("requires a valid document of the declared type", () => {
    const schema = payerDetailsSchema({ document: ["CPF"] });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ document: { type: "CPF", number: "11111111111" } }).success).toBe(false);
    expect(schema.safeParse({ document: { type: "CNPJ", number: "11222333000181" } }).success).toBe(false);
    expect(schema.parse({ document: { type: "CPF", number: "529.982.247-25" } })).toEqual({ document: { type: "CPF", number: "52998224725" } });
  });
  it("validates billing address only when declared and strips raw card fields", () => {
    const schema = payerDetailsSchema({ billingAddress: true });
    expect(schema.safeParse({}).success).toBe(false);
    const billingAddress = { postalCode: "01310-100", street: "Av Paulista", number: "100", district: "Bela Vista", city: "São Paulo", state: "SP", country: "BR" };
    expect(schema.safeParse({ billingAddress: { ...billingAddress, state: "XX" } }).success).toBe(false);
    expect(schema.parse({ billingAddress, cvv: "123", document: {} })).toEqual({ billingAddress: { ...billingAddress, postalCode: "01310100" } });
  });
});
