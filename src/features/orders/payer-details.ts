// Shared validation. Payer details belong to this checkout, never to basic signup.
import { z } from "zod";
import { isValidCPF, isValidCNPJ, onlyDigits, UF_CODES } from "@/lib/br";
import type { PaymentPayerDetails, PayerRequirements } from "@/server/payments/types";

export function payerDetailsSchema(requirements: PayerRequirements): z.ZodType<PaymentPayerDetails> {
  const document = z.object({
    type: z.enum(["CPF", "CNPJ"]),
    number: z.string().trim().max(30).transform(onlyDigits),
  }).superRefine((value, ctx) => {
    if (!requirements.document?.includes(value.type) || !(value.type === "CPF" ? isValidCPF(value.number) : isValidCNPJ(value.number))) {
      ctx.addIssue({ code: "custom", message: "Informe um CPF/CNPJ válido para o pagamento." });
    }
  });
  const required = (max: number) => z.string().trim().min(1, "Preencha o endereço de cobrança.").max(max);
  const billingAddress = z.object({
    postalCode: z.string().trim().regex(/^\d{5}-?\d{3}$/, "Informe um CEP válido.").transform(onlyDigits),
    street: required(200), number: required(30), district: required(120), city: required(120),
    state: z.enum(UF_CODES, { error: "Informe uma UF válida." }), country: z.literal("BR"),
  });
  // Never forward unsolicited personal data, even if a caller bypasses the UI.
  return z.object({
    ...(requirements.document?.length ? { document } : {}),
    ...(requirements.billingAddress ? { billingAddress } : {}),
  }) as z.ZodType<PaymentPayerDetails>;
}
