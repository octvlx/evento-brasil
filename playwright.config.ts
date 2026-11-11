import { defineConfig, devices } from "@playwright/test";

// E2E contra o servidor de desenvolvimento com o banco populado pelo seed
// (npm run db:seed). Usa o Microsoft Edge instalado (canal "msedge") por padrão;
// defina PW_CHANNEL=chromium após `npx playwright install chromium` se preferir.
const channel = process.env.PW_CHANNEL ?? "msedge";
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const port = new URL(baseURL).port || "3000";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  // Na CI, uma nova tentativa para falhas de ambiente (servidor de dev sob carga); o
  // relatório marca como "flaky" o que só passou na segunda vez. Local: sem repetição.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Edge"], channel: channel === "chromium" ? undefined : channel } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: channel === "chromium" ? undefined : channel }, testMatch: /public\.spec\.ts/ },
  ],
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: process.env.E2E_ISOLATED !== "1",
    timeout: 180_000,
  },
});
