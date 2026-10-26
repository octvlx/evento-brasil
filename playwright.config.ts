import { defineConfig, devices } from "@playwright/test";

// E2E contra o servidor de desenvolvimento com o banco populado pelo seed
// (npm run db:seed). Usa o Microsoft Edge instalado (canal "msedge") por padrão;
// defina PW_CHANNEL=chromium após `npx playwright install chromium` se preferir.
const channel = process.env.PW_CHANNEL ?? "msedge";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Edge"], channel: channel === "chromium" ? undefined : channel } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: channel === "chromium" ? undefined : channel }, testMatch: /public\.spec\.ts/ },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
