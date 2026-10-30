import { z } from "zod";
import { isValidCPF, onlyDigits, UF_CODES } from "@/lib/br";

const text = (max: number) => z.string().trim().min(1, "Campo obrigatório").max(max);
export const buyerPersonalSchema = z.object({
  name: z.string().trim().min(2, "Informe seu nome completo").max(120),
  cpf: z.string().trim().max(30).optional().transform((value) => value ? onlyDigits(value) : undefined).refine((value) => !value || isValidCPF(value), "CPF inválido"),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Informe sua data de nascimento").refine((value) => {
    const date = new Date(value + "T00:00:00.000Z");
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= new Date().toISOString().slice(0, 10);
  }, "Informe uma data de nascimento válida, que não esteja no futuro").refine((value) => value >= "1900-01-01", "A data de nascimento deve ser igual ou posterior a 01/01/1900"),
});
export type BuyerPersonalInput = z.input<typeof buyerPersonalSchema>;

export const buyerAddressSchema = z.object({
  postalCode: z.string().trim().regex(/^\d{5}-?\d{3}$/, "Informe um CEP válido").transform(onlyDigits),
  street: text(200), number: text(30),
  complement: z.string().trim().max(160).optional().transform((value) => value || undefined),
  district: text(120), city: text(120), state: z.enum(UF_CODES, { error: "Selecione um estado válido" }),
});
export type BuyerAddressInput = z.input<typeof buyerAddressSchema>;
export type BuyerAddress = z.output<typeof buyerAddressSchema>;
export interface BuyerCheckoutProfile {
  name: string; email: string; emailVerified: boolean; cpfMasked: string | null; birthDate: string | null; personalComplete: boolean; address: (Omit<BuyerAddress, "state"> & { state: string }) | null;
}
