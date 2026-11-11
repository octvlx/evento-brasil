import { describe, expect, it } from "vitest";
import { checkProductionDb, checkProductionEnv, hasFailures, type CheckItem } from "@/lib/production-check";

const key32 = (c: string) => Buffer.alloc(32, c).toString("base64");
const good: Record<string, string> = {
  APP_URL: "https://ingressos.exemplo.com.br",
  DATABASE_URL: "postgresql://u:p@db.exemplo.com.br:5432/app?sslmode=require",
  AUTH_SECRET: "a".repeat(48),
  CRON_SECRET: "c".repeat(32),
  DATA_ENCRYPTION_KEY: key32("d"),
  PAYMENT_PROVIDER: "mercadopago",
  MERCADO_PAGO_CLIENT_ID: "123",
  MERCADO_PAGO_CLIENT_SECRET: "segredo-app-mp-0123456789",
  MERCADO_PAGO_WEBHOOK_SECRET: "w".repeat(32),
  MERCADO_PAGO_TOKEN_ENCRYPTION_KEY: key32("m"),
  SETTLEMENT_ENABLED: "true",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_chave_resend_0123456789",
  EMAIL_FROM: "QQPega <nao-responda@exemplo.com.br>",
  STORAGE_PROVIDER: "s3",
  OBJECT_STORAGE_BUCKET: "b",
  OBJECT_STORAGE_ACCESS_KEY: "k",
  OBJECT_STORAGE_SECRET_KEY: "segredo-bucket-0123456789",
  OBJECT_STORAGE_PUBLIC_URL: "https://cdn.exemplo.com.br",
};
const fails = (items: CheckItem[]) => items.filter((i) => i.level === "fail").map((i) => i.title);
const warns = (items: CheckItem[]) => items.filter((i) => i.level === "warn").map((i) => i.title);

describe("verificação de produção: configuração", () => {
  it("configuração completa passa sem bloqueios nem avisos", () => {
    const items = checkProductionEnv(good);
    expect(fails(items)).toEqual([]);
    expect(warns(items)).toEqual([]);
    expect(hasFailures(items)).toBe(false);
  });

  it("nunca devolve valores das variáveis, só nomes", () => {
    const bad: Record<string, string> = {
      ...good,
      AUTH_SECRET: "segredo-auth-".padEnd(40, "z"),
      CRON_SECRET: "segredo-auth-".padEnd(40, "z"),
      DATABASE_URL: "postgresql://u:senha-do-banco@localhost:5432/app",
    };
    const out = JSON.stringify([...checkProductionEnv(good), ...checkProductionEnv(bad)]);
    for (const n of ["AUTH_SECRET", "DATA_ENCRYPTION_KEY", "MERCADO_PAGO_CLIENT_SECRET", "MERCADO_PAGO_WEBHOOK_SECRET", "MERCADO_PAGO_TOKEN_ENCRYPTION_KEY", "OBJECT_STORAGE_SECRET_KEY", "RESEND_API_KEY"]) {
      expect(out).not.toContain(bad[n]);
    }
    expect(out).not.toContain("senha-do-banco");
  });

  it("bloqueia valores de desenvolvimento, chaves curtas ou repetidas", () => {
    expect(fails(checkProductionEnv({ ...good, AUTH_SECRET: "dev-only-x".padEnd(40, "x") }))).toContain("AUTH_SECRET");
    expect(fails(checkProductionEnv({ ...good, CRON_SECRET: "curto-demais" }))).toContain("CRON_SECRET");
    expect(fails(checkProductionEnv({ ...good, DATA_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }))).toContain("DATA_ENCRYPTION_KEY");
    expect(fails(checkProductionEnv({ ...good, CRON_SECRET: good.AUTH_SECRET }))).toContain("Segredos repetidos");
    expect(fails(checkProductionEnv({ ...good, MERCADO_PAGO_TOKEN_ENCRYPTION_KEY: good.DATA_ENCRYPTION_KEY }))).toContain("Segredos repetidos");
  });

  it("bloqueia URL sem HTTPS ou local, pagamento simulado, e-mail de teste, imagens locais e 2FA desligado", () => {
    expect(fails(checkProductionEnv({ ...good, APP_URL: "http://ingressos.exemplo.com.br" }))).toContain("APP_URL");
    expect(fails(checkProductionEnv({ ...good, APP_URL: "https://app.localhost" }))).toContain("APP_URL");
    expect(fails(checkProductionEnv({ ...good, PAYMENT_PROVIDER: "simulated" }))).toContain("PAYMENT_PROVIDER");
    expect(fails(checkProductionEnv({ ...good, ALLOW_SIMULATED_PAYMENTS_IN_PRODUCTION: "true" }))).toContain("ALLOW_SIMULATED_PAYMENTS_IN_PRODUCTION");
    expect(fails(checkProductionEnv({ ...good, MERCADO_PAGO_WEBHOOK_SECRET: "" }))).toContain("Mercado Pago");
    expect(fails(checkProductionEnv({ ...good, EMAIL_FROM: "QQPega <a@example.com>" }))).toContain("EMAIL_FROM");
    expect(fails(checkProductionEnv({ ...good, EMAIL_PROVIDER: "console" }))).toContain("EMAIL_PROVIDER");
    expect(fails(checkProductionEnv({ ...good, STORAGE_PROVIDER: "local" }))).toContain("STORAGE_PROVIDER");
    expect(fails(checkProductionEnv({ ...good, OBJECT_STORAGE_PUBLIC_URL: "http://cdn.exemplo.com.br" }))).toContain("OBJECT_STORAGE_PUBLIC_URL");
    expect(fails(checkProductionEnv({ ...good, MFA_REQUIRED: "false" }))).toContain("MFA_REQUIRED");
  });

  it("integrações opcionais: tudo ou nada", () => {
    expect(fails(checkProductionEnv({ ...good, GOOGLE_CLIENT_ID: "id" }))).toContain("Login com Google");
    expect(fails(checkProductionEnv({ ...good, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }))).toEqual([]);
  });

  it("avisa (sem bloquear) banco sem TLS, repasse desligado e checagem de senha vazada desligada", () => {
    const items = checkProductionEnv({ ...good, DATABASE_URL: "postgresql://u:p@db.exemplo.com.br/app", SETTLEMENT_ENABLED: "false", PASSWORD_BREACH_CHECK: "false" });
    expect(fails(items)).toEqual([]);
    expect(warns(items).sort()).toEqual(["DATABASE_URL", "PASSWORD_BREACH_CHECK", "SETTLEMENT_ENABLED"]);
  });
});

describe("verificação de produção: banco", () => {
  const ok = { pendingMigrations: [], failedMigrations: [], demoAccounts: 0, activeAdmins: 1, adminsWithoutMfa: 0, cities: 10 };

  it("banco pronto não bloqueia", () => {
    expect(fails(checkProductionDb(ok))).toEqual([]);
    expect(warns(checkProductionDb(ok))).toEqual([]);
  });

  it("bloqueia contas demo, falta de administrador e migração com falha; avisa pendências", () => {
    expect(fails(checkProductionDb({ ...ok, demoAccounts: 3 }))).toEqual(["Contas de demonstração"]);
    expect(fails(checkProductionDb({ ...ok, activeAdmins: 0 }))).toEqual(["Administrador"]);
    expect(fails(checkProductionDb({ ...ok, failedMigrations: ["x"] }))).toEqual(["Migrações com falha"]);
    expect(warns(checkProductionDb({ ...ok, pendingMigrations: ["y"], adminsWithoutMfa: 1, cities: 0 })).sort()).toEqual(["Administrador", "Cidades", "Migrações pendentes"]);
  });
});
