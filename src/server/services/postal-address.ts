import "server-only";
import { z } from "zod";
import { UF_CODES } from "@/lib/br";
import { AppError } from "../errors";

const responseSchema = z.object({ cep: z.string(), logradouro: z.string(), bairro: z.string(), localidade: z.string().min(1), uf: z.enum(UF_CODES) });

/** CEP is the only data sent to ViaCEP. Users can complete or correct its suggestions manually. */
export async function lookupPostalAddress(raw: string) {
  const postalCode = raw.trim().replace(/^(\d{5})-(\d{3})$/, "$1$2");
  if (!/^\d{8}$/.test(postalCode)) throw new AppError("VALIDATION", "Informe um CEP de 8 dígitos.");
  try {
    const response = await fetch(`https://viacep.com.br/ws/${postalCode}/json/`, { signal: AbortSignal.timeout(5_000), cache: "no-store", redirect: "error" });
    if (!response.ok) throw new Error("postal lookup unavailable");
    const data: unknown = await response.json();
    if (data && typeof data === "object" && "erro" in data && data.erro) throw new AppError("NOT_FOUND", "CEP não encontrado. Confira o número ou preencha o endereço manualmente.");
    const parsed = responseSchema.safeParse(data);
    if (!parsed.success || parsed.data.cep.replace(/\D/g, "") !== postalCode) throw new Error("invalid postal response");
    return { postalCode, street: parsed.data.logradouro, district: parsed.data.bairro, city: parsed.data.localidade, state: parsed.data.uf };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("PROVIDER_ERROR", "Não foi possível consultar o CEP. Preencha o endereço manualmente.");
  }
}
