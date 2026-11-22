import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deploy de Preview da Vercel = homologação: NODE_ENV=production + VERCEL_ENV=preview.
const strong = {
  AUTH_SECRET: "a".repeat(32),
  DATA_ENCRYPTION_KEY: "b".repeat(32),
  CRON_SECRET: "c".repeat(32),
  QR_TOKEN_SECRET: "d".repeat(32),
  SIMULATED_WEBHOOK_SECRET: "e".repeat(32),
  PAYMENT_PROVIDER: "mercadopago",
  EMAIL_PROVIDER: "console",
  MERCADO_PAGO_OAUTH_TEST_TOKEN: "true",
};
function stub(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries({ ...strong, ...vars })) vi.stubEnv(k, v);
}
const load = () => import("@/server/env");

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_URL", undefined);
  vi.stubEnv("APP_BASE_URL", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("Preview da Vercel", () => {
  it("aceita sandbox do MP e e-mail no log, com a URL do branch", async () => {
    stub({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "ticket24-git-pr-ticket24.vercel.app" });
    const m = await load();
    expect(m.env().APP_URL).toBe("https://ticket24-git-pr-ticket24.vercel.app");
    expect(m.isPreviewDeployment()).toBe(true);
    expect(m.isLiveProduction()).toBe(false);
    expect(m.isProduction()).toBe(true);
  });

  it("continua exigindo segredos fortes", async () => {
    stub({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "x.vercel.app", AUTH_SECRET: "dev-only-replace-with-random-secret" });
    await expect(load().then((m) => m.env())).rejects.toThrow(/AUTH_SECRET/);
  });

  it("produção de verdade segue recusando sandbox e e-mail no log", async () => {
    stub({ VERCEL_ENV: "production", APP_URL: "https://ticket24.com.br" });
    await expect(load().then((m) => m.env())).rejects.toThrow(/MERCADO_PAGO_OAUTH_TEST_TOKEN/);
    vi.resetModules();
    stub({ VERCEL_ENV: "production", APP_URL: "https://ticket24.com.br", MERCADO_PAGO_OAUTH_TEST_TOKEN: "" });
    await expect(load().then((m) => m.env())).rejects.toThrow(/provedor real de e-mail/);
  });

  it("fora da Vercel (Cloud Run) não há Preview", async () => {
    stub({ VERCEL_ENV: undefined, APP_URL: "https://ticket24.com.br", MERCADO_PAGO_OAUTH_TEST_TOKEN: "", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test", EMAIL_FROM: "TICKET24 <nao-responda@ticket24.com.br>" });
    const m = await load();
    expect(m.isPreviewDeployment()).toBe(false);
    expect(m.isLiveProduction()).toBe(true);
  });
});

describe("e-mail no Preview", () => {
  it("só registra no log, sem gravar em disco", async () => {
    stub({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "x.vercel.app" });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { ConsoleEmailAdapter } = await import("@/server/email");
    const r = await new ConsoleEmailAdapter().send({ to: "a@example.com", subject: "Confirme", html: "<p>x</p>", text: "link https://x.vercel.app/v/abc" });
    expect(r.id).toMatch(/^preview:/);
    expect(info.mock.calls[0][0]).toContain("https://x.vercel.app/v/abc");
    info.mockRestore();
  });
});
