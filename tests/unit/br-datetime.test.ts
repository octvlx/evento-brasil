import { describe, expect, it } from "vitest";
import { formatCNPJ, formatCPF, formatPhoneBR, isValidCNPJ, isValidCPF, isValidMobileBR, UFS } from "@/lib/br";
import { localDayRange, utcToZonedLocalInput, weekendRange, zonedLocalToUtc } from "@/lib/datetime";
import { couponInputSchema, createOrderSchema, eventInputSchema, organizerApplicationSchema, ticketTypeInputSchema } from "@/features/schemas";
import { step2Schema, step3Schema } from "@/features/organizer/wizard-steps";

describe("documentos e telefone", () => {
  it("valida CPF", () => {
    expect(isValidCPF("529.982.247-25")).toBe(true);
    expect(isValidCPF("529.982.247-24")).toBe(false);
    expect(isValidCPF("111.111.111-11")).toBe(false);
    expect(formatCPF("52998224725")).toBe("529.982.247-25");
  });
  it("valida CNPJ", () => {
    expect(isValidCNPJ("11.222.333/0001-81")).toBe(true);
    expect(isValidCNPJ("11.222.333/0001-80")).toBe(false);
    expect(isValidCNPJ("00000000000000")).toBe(false);
    expect(formatCNPJ("11222333000181")).toBe("11.222.333/0001-81");
  });
  it("valida celular brasileiro", () => {
    expect(isValidMobileBR("(11) 91234-5678")).toBe(true);
    expect(isValidMobileBR("+55 21 99876-5432")).toBe(true);
    expect(isValidMobileBR("(11) 3123-4567")).toBe(false);
    expect(isValidMobileBR("(01) 91234-5678")).toBe(false);
    expect(formatPhoneBR("11912345678")).toBe("(11) 91234-5678");
  });
  it("lista as 26 UFs + DF", () => {
    expect(UFS).toHaveLength(27);
    expect(new Set(UFS.map((u) => u.uf)).size).toBe(27);
  });
  it("schema do organizador exige documento coerente com o tipo", () => {
    const base = { name: "Org", legalName: "Org LTDA", contactEmail: "a@b.com" };
    expect(organizerApplicationSchema.safeParse({ ...base, legalType: "COMPANY", document: "11222333000181" }).success).toBe(true);
    expect(organizerApplicationSchema.safeParse({ ...base, legalType: "COMPANY", document: "52998224725" }).success).toBe(false);
    expect(organizerApplicationSchema.safeParse({ ...base, legalType: "INDIVIDUAL", document: "52998224725" }).success).toBe(true);
  });
  it("schema de pedido não aceita preço vindo do cliente", () => {
    const parsed = createOrderSchema.parse({
      eventId: "e",
      items: [{ ticketTypeId: "t", quantity: 1, priceCents: 1 }],
      buyerName: "Fulano",
      buyerEmail: "f@x.com",
      idempotencyKey: "4f0e2a2e-5d9b-4c5e-9a43-1b2c3d4e5f60",
      totalCents: 1,
    });
    expect(parsed.items[0]).not.toHaveProperty("priceCents");
    expect(parsed).not.toHaveProperty("totalCents");
  });
});

describe("fusos horários", () => {
  it.each(["2026-02-29T20:00", "2026-02-31T20:00", "2026-04-31T20:00", "2026-13-01T20:00", "2026-01-01T24:00", "2026-01-01T12:60"])("recusa data/hora inexistente: %s", (local) => {
    expect(() => zonedLocalToUtc(local, "America/Sao_Paulo")).toThrow(RangeError);
    expect(eventInputSchema.shape.startsAtLocal.safeParse(local).success).toBe(false);
    expect(eventInputSchema.shape.endsAtLocal.safeParse(local).success).toBe(false);
    expect(eventInputSchema.shape.salesStartLocal.safeParse(local).success).toBe(false);
    expect(eventInputSchema.shape.salesEndLocal.safeParse(local).success).toBe(false);
    expect(ticketTypeInputSchema.shape.salesStartLocal.safeParse(local).success).toBe(false);
    expect(step2Schema.shape.startsAtLocal.safeParse(local).success).toBe(false);
    expect(step2Schema.shape.endsAtLocal.safeParse(local).success).toBe(false);
    expect(step3Schema.shape.salesStartLocal.safeParse(local).success).toBe(false);
    expect(step3Schema.shape.salesEndLocal.safeParse(local).success).toBe(false);
    const coupon = couponInputSchema.safeParse({ code: "TESTE", discountType: "PERCENT", percentBps: 1000, validUntilLocal: local });
    expect(coupon.success).toBe(false);
    expect(coupon.error?.issues.some((issue) => issue.path[0] === "validUntilLocal")).toBe(true);
  });

  it("aceita 29/02 em ano bissexto e campos opcionais vazios", () => {
    expect(zonedLocalToUtc("2028-02-29T20:00", "America/Sao_Paulo").toISOString()).toBe("2028-02-29T23:00:00.000Z");
    expect(eventInputSchema.shape.startsAtLocal.safeParse("2028-02-29T20:00").success).toBe(true);
    expect(ticketTypeInputSchema.shape.salesStartLocal.safeParse("").success).toBe(true);
    expect(couponInputSchema.safeParse({ code: "TESTE", discountType: "PERCENT", percentBps: 1000 }).success).toBe(true);
  });

  it("converte horário local para UTC por fuso", () => {
    expect(zonedLocalToUtc("2026-11-20T20:00", "America/Sao_Paulo").toISOString()).toBe("2026-11-20T23:00:00.000Z");
    expect(zonedLocalToUtc("2026-11-20T20:00", "America/Manaus").toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(zonedLocalToUtc("2026-11-20T20:00", "America/Noronha").toISOString()).toBe("2026-11-20T22:00:00.000Z");
    expect(zonedLocalToUtc("2026-11-20T20:00", "America/Rio_Branco").toISOString()).toBe("2026-11-21T01:00:00.000Z");
  });
  it("ida e volta preserva o horário local", () => {
    const utc = zonedLocalToUtc("2027-02-14T09:30", "America/Cuiaba");
    expect(utcToZonedLocalInput(utc, "America/Cuiaba")).toBe("2027-02-14T09:30");
  });
  it("janelas de hoje e fim de semana", () => {
    const now = new Date("2026-10-28T15:00:00Z"); // quarta-feira
    const today = localDayRange(now, "America/Sao_Paulo");
    expect(today.from.toISOString()).toBe("2026-10-28T03:00:00.000Z");
    expect(today.to.toISOString()).toBe("2026-10-29T03:00:00.000Z");
    const wk = weekendRange(now, "America/Sao_Paulo");
    expect(wk.from.toISOString()).toBe("2026-10-30T21:00:00.000Z"); // sexta 18h
    expect(wk.to.toISOString()).toBe("2026-11-02T03:00:00.000Z"); // segunda 0h
  });
});
