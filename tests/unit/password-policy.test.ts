import { describe, expect, it } from "vitest";
import { changePasswordSchema, registerSchema } from "@/features/schemas";
import { isCommonPassword, PASSWORD_MESSAGES, passwordIssues, passwordStrength } from "@/lib/password-policy";

describe("política de senhas", () => {
  it("lista cada requisito faltante com a mensagem em pt-BR", () => {
    expect(passwordIssues("abc")).toEqual([
      "Utilize pelo menos 8 caracteres.",
      "Adicione uma letra maiúscula.",
      "Adicione pelo menos um número.",
      "Adicione pelo menos um caractere especial.",
    ]);
    expect(passwordIssues("Brasil@2026Eventos!")).toEqual([]);
    expect(passwordIssues("        ")).toEqual([PASSWORD_MESSAGES.blank]);
    expect(passwordIssues("Aa1!" + "x".repeat(130))).toEqual([PASSWORD_MESSAGES.tooLong]);
  });

  it("recusa senhas comuns mesmo com maiúscula, número e símbolo", () => {
    for (const p of ["Senha@123", "P@ssw0rd!", "Brasil2026!", "Flamengo#1", "Qwerty123!"]) {
      expect(isCommonPassword(p)).toBe(true);
      expect(passwordIssues(p)).toEqual([PASSWORD_MESSAGES.common]);
    }
    expect(isCommonPassword("Lua-Cheia#Sobre7Mares")).toBe(false);
  });

  it("força não sobe só por ter os quatro tipos de caractere", () => {
    expect(passwordStrength("")).toEqual({ level: 0, label: "" });
    expect(passwordStrength("abc").label).toBe("Fraca");
    expect(passwordStrength("Ab1!xyzw").label).toBe("Média");
    expect(passwordStrength("Lua-Cheia#Sobre7Mares").label).toBe("Forte");
    // Comprido, mas com sequência e ano: não chega a forte.
    expect(passwordStrength("Casa1234!2026").label).toBe("Média");
    // Palavra comum + números: fraca.
    expect(passwordStrength("Abc1234!2026").label).toBe("Fraca");
  });

  it("cadastro e troca validam a confirmação no schema (servidor e cliente)", () => {
    const base = { name: "Ana", email: "ana@test.local", confirmEmail: "ana@test.local", password: "Lua-Cheia#Sobre7Mares", acceptTerms: true, acceptPrivacy: true };
    expect(registerSchema.safeParse({ ...base, confirmPassword: "outra" }).error?.issues[0]).toMatchObject({ path: ["confirmPassword"], message: PASSWORD_MESSAGES.mismatch });
    expect(registerSchema.safeParse({ ...base, confirmPassword: base.password }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, confirmEmail: "ana@test.locla", confirmPassword: base.password }).error?.issues[0]).toMatchObject({ path: ["confirmEmail"], message: "Os e-mails não coincidem." });
    expect(registerSchema.safeParse({ ...base, confirmEmail: " ANA@test.local ", confirmPassword: base.password }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, password: "fraca", confirmPassword: "fraca" }).success).toBe(false);
    const change = changePasswordSchema.safeParse({ currentPassword: "x", newPassword: "Lua-Cheia#Sobre7Mares", confirmPassword: "diferente" });
    expect(change.error?.issues[0].message).toBe(PASSWORD_MESSAGES.newMismatch);
  });
});
