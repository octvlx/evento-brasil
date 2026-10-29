import { describe, expect, it } from "vitest";
import { registerDetailsSchema, registerSchema } from "@/features/schemas";

const details = {
  name: "Pessoa Compradora",
  email: "pessoa@example.com",
  password: "senha-segura-123",
  phone: "(11) 91234-5678",
  smsConsent: true,
  acceptTerms: true,
  acceptPrivacy: true,
};

describe("cadastro mínimo e confirmação de celular", () => {
  it("permite solicitar o SMS sem dados fiscais ou documentos", () => {
    expect(registerDetailsSchema.safeParse(details).success).toBe(true);
  });

  it.each([undefined, "", "(11) 3123-4567"])("recusa cadastro sem celular válido: %s", (phone) => {
    expect(registerSchema.safeParse({ ...details, phone, phoneVerificationToken: "proof" }).success).toBe(false);
  });

  it.each([undefined, ""])("recusa concluir cadastro sem comprovante de verificação: %s", (phoneVerificationToken) => {
    expect(registerSchema.safeParse({ ...details, phoneVerificationToken }).success).toBe(false);
  });

  it("exige autorização explícita para envio do SMS", () => {
    expect(registerDetailsSchema.safeParse({ ...details, smsConsent: false }).success).toBe(false);
    expect(registerDetailsSchema.safeParse({ ...details, smsConsent: undefined }).success).toBe(false);
  });

  it("mantém termos e ciência da política de privacidade obrigatórios", () => {
    expect(registerDetailsSchema.safeParse({ ...details, acceptTerms: false }).success).toBe(false);
    expect(registerDetailsSchema.safeParse({ ...details, acceptPrivacy: false }).success).toBe(false);
  });
});
