import path from "node:path";
import { defineConfig } from "vitest/config";

const TEST_DB_PORT = Number(process.env.TEST_DB_PORT ?? 5434);

const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  // "server-only" lanÃ§a erro fora do bundler do Next; nos testes Ã© um no-op.
  "server-only": path.resolve(import.meta.dirname, "tests/support/empty.ts"),
};

const testEnv = {
  NODE_ENV: "test" as const,
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? `postgresql://evento_test:evento_test_pw@localhost:${TEST_DB_PORT}/evento_test`,
  APP_URL: "http://localhost:3000",
  AUTH_SECRET: "test-only-auth-secret-0123456789",
  DATA_ENCRYPTION_KEY: "dGVzdC1vbmx5LWtleS0wMTIzNDU2Nzg5YWJjZGVmMDE=",
  CRON_SECRET: "test-only-cron",
  PAYMENT_PROVIDER: "simulated",
  SIMULATED_WEBHOOK_SECRET: "test-only-webhook-secret",
  RESERVATION_MINUTES: "15",
  EMAIL_PROVIDER: "console",
  STORAGE_PROVIDER: "local",
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node", env: testEnv } },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          env: testEnv,
          globalSetup: ["tests/support/global-setup.ts"],
          // Banco compartilhado: arquivos em sÃ©rie.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
