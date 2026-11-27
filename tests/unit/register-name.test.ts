import { describe, expect, it } from "vitest";
import { FIRST_NAME_MAX, LAST_NAME_MAX, registerSchema } from "@/features/schemas";

const base = {
  firstName: "Ana",
  lastName: "Lima",
  email: "ana@test.local",
  confirmEmail: "ana@test.local",
  password: "Lua-Cheia#Sobre7Mares",
  confirmPassword: "Lua-Cheia#Sobre7Mares",
  acceptTerms: true as const,
  acceptPrivacy: true as const,
};
const issue = (input: Partial<typeof base>, field: "firstName" | "lastName") =>
  registerSchema.safeParse({ ...base, ...input }).error?.issues.find((i) => i.path[0] === field)?.message;

describe("cadastro: nome e sobrenome", () => {
  it("junta Nome e Sobrenome num nome só, sem espaços sobrando", () => {
    const out = registerSchema.parse({ ...base, firstName: "  Maria   Clara ", lastName: " de  Souza\tD’Ávila " });
    expect(out.name).toBe("Maria Clara de Souza D’Ávila");
    expect(out).not.toHaveProperty("firstName");
    expect(out).not.toHaveProperty("lastName");
  });

  it("os dois campos são obrigatórios (espaço em branco não conta)", () => {
    expect(issue({ firstName: "" }, "firstName")).toBe("Informe seu nome");
    expect(issue({ firstName: "   " }, "firstName")).toBe("Informe seu nome");
    expect(issue({ lastName: "" }, "lastName")).toBe("Informe seu sobrenome");
    expect(issue({ lastName: " \t " }, "lastName")).toBe("Informe seu sobrenome");
  });

  it("limita o tamanho e o total cabe nos 120 caracteres do perfil", () => {
    expect(FIRST_NAME_MAX + 1 + LAST_NAME_MAX).toBeLessThanOrEqual(120);
    expect(registerSchema.safeParse({ ...base, firstName: "A".repeat(FIRST_NAME_MAX), lastName: "B".repeat(LAST_NAME_MAX) }).success).toBe(true);
    expect(issue({ firstName: "A".repeat(FIRST_NAME_MAX + 1) }, "firstName")).toBe(`O nome pode ter no máximo ${FIRST_NAME_MAX} caracteres`);
    expect(issue({ lastName: "B".repeat(LAST_NAME_MAX + 1) }, "lastName")).toBe(`O sobrenome pode ter no máximo ${LAST_NAME_MAX} caracteres`);
  });

  it("aceita acentos, hífen e apóstrofo; recusa números e símbolos", () => {
    expect(registerSchema.safeParse({ ...base, firstName: "João-Pedro", lastName: "O'Neil Conceição" }).success).toBe(true);
    expect(issue({ firstName: "Ana2" }, "firstName")).toMatch(/só letras/);
    expect(issue({ lastName: "<script>" }, "lastName")).toMatch(/só letras/);
    expect(issue({ lastName: "-Lima" }, "lastName")).toMatch(/só letras/);
  });

  it("o campo antigo name não substitui Nome e Sobrenome", () => {
    expect(registerSchema.safeParse({ ...base, firstName: undefined, lastName: undefined, name: "Ana Lima" }).success).toBe(false);
  });
});
