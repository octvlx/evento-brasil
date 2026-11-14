import "server-only";
import { z } from "zod";

const bool = z
  .enum(["true", "false", ""])
  .optional()
  .transform((v) => v === "true");
const int = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_BASE_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(16),
  DATA_ENCRYPTION_KEY: z.string().min(16),
  CRON_SECRET: z.string().min(8),
  PAYMENT_PROVIDER: z.enum(["simulated", "mercadopago"]).default("simulated"),
  SIMULATED_WEBHOOK_SECRET: z
    .string()
    .min(8)
    .default("dev-only-simulated-webhook-secret"),
  ALLOW_SIMULATED_PAYMENTS_IN_PRODUCTION: bool,
  MERCADO_PAGO_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  MERCADO_PAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADO_PAGO_CLIENT_ID: z.string().optional(),
  MERCADO_PAGO_CLIENT_SECRET: z.string().optional(),
  MERCADO_PAGO_WEBHOOK_SECRET: z.union([z.literal(""), z.string().min(8)]).optional(),
  // OAuth em modo sandbox: pede credenciais de teste do vendedor (test_token=true). Proibido em produção.
  MERCADO_PAGO_OAUTH_TEST_TOKEN: bool,
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SETTLEMENT_ENABLED: bool,
  RESERVATION_MINUTES: int(15),
  EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  EMAIL_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_REPLY_TO: z.union([z.literal(""), z.string().email()]).optional(),
  // Cadastros por IP por hora (anti-abuso). A suíte e2e isolada cria muitas contas do
  // mesmo endereço e sobe o valor; em produção fica o padrão.
  SIGNUP_RATE_LIMIT_PER_HOUR: int(5),
  EMAIL_VERIFICATION_EXPIRATION_MINUTES: int(30),
  PASSWORD_RESET_EXPIRATION_MINUTES: int(30),
  // Consulta de senhas vazadas (Pwned Passwords, k-anonimato). Ligada por padrão, exceto
  // nos testes; "false" desliga. Falha aberta: indisponibilidade não bloqueia o fluxo.
  PASSWORD_BREACH_CHECK: z
    .enum(["true", "false", ""])
    .optional()
    .transform((v) => (v ? v === "true" : process.env.NODE_ENV !== "test")),
  EMAIL_FROM: z.string().default("QQPega <nao-responda@example.com>"),
  // Alertas operacionais (webhook parado, reembolso com falha, etc.): e-mails separados
  // por vírgula. Vazio = só log e o quadro na home do /admin.
  ALERT_EMAILS: z.string().optional(),
  STORAGE_PROVIDER: z.enum(["local", "s3"]).default("local"),
  OBJECT_STORAGE_ENDPOINT: z.string().optional(),
  OBJECT_STORAGE_REGION: z.string().default("auto"),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().optional(),
  OBJECT_STORAGE_PUBLIC_URL: z.string().optional(),
  // Carteiras digitais (docs/wallet.md). Cada uma liga só com todas as suas variáveis.
  // Certificados/chaves: PEM (quebras de linha como "\n") ou PEM em base64.
  APPLE_WALLET_PASS_TYPE_ID: z.string().optional(),
  APPLE_WALLET_TEAM_ID: z.string().optional(),
  APPLE_WALLET_SIGNER_CERT: z.string().optional(),
  APPLE_WALLET_SIGNER_KEY: z.string().optional(),
  APPLE_WALLET_SIGNER_KEY_PASSPHRASE: z.string().optional(),
  APPLE_WALLET_WWDR_CERT: z.string().optional(),
  GOOGLE_WALLET_ISSUER_ID: z.string().optional(),
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  GOOGLE_WALLET_PRIVATE_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Variáveis de ambiente inválidas: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  const e = parsed.data;
  if (e.APP_BASE_URL) {
    if (
      process.env.APP_URL &&
      new URL(e.APP_URL).origin !== new URL(e.APP_BASE_URL).origin
    )
      throw new Error("APP_URL e APP_BASE_URL devem usar a mesma origem.");
    e.APP_URL = e.APP_BASE_URL;
  }
  if (e.EMAIL_PROVIDER === "resend" && !(e.RESEND_API_KEY || e.EMAIL_API_KEY))
    throw new Error("RESEND_API_KEY não configurada.");
  if (e.NODE_ENV === "production") {
    if (e.MERCADO_PAGO_OAUTH_TEST_TOKEN)
      throw new Error("MERCADO_PAGO_OAUTH_TEST_TOKEN é só para sandbox e não pode ser usado em produção.");
    if (e.EMAIL_PROVIDER !== "resend")
      throw new Error("Configure um provedor real de e-mail em produção.");
    const from = e.EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? e.EMAIL_FROM;
    const sender = z.string().email().safeParse(from);
    if (
      !sender.success ||
      /@(resend\.dev|example\.(com|org)|localhost)$/i.test(from)
    )
      throw new Error(
        "EMAIL_FROM exige remetente de domínio próprio verificado em produção.",
      );
    if (new URL(e.APP_URL).protocol !== "https:")
      throw new Error("APP_URL deve usar HTTPS em produção.");
    const devOnly = (
      [
        "AUTH_SECRET",
        "DATA_ENCRYPTION_KEY",
        "CRON_SECRET",
        "SIMULATED_WEBHOOK_SECRET",
      ] as const
    ).filter((k) => e[k].startsWith("dev-only"));
    if (
      devOnly.length &&
      !(
        devOnly.length === 1 &&
        devOnly[0] === "SIMULATED_WEBHOOK_SECRET" &&
        e.PAYMENT_PROVIDER !== "simulated"
      )
    ) {
      throw new Error(
        `Segredos de desenvolvimento usados em produção: ${devOnly.join(", ")}`,
      );
    }
    if (
      e.PAYMENT_PROVIDER === "simulated" &&
      !e.ALLOW_SIMULATED_PAYMENTS_IN_PRODUCTION
    ) {
      throw new Error(
        "PAYMENT_PROVIDER=simulated não é permitido em produção.",
      );
    }
  }
  cached = e;
  return e;
}

export const isProduction = () => env().NODE_ENV === "production";
