// Explicit schema-only OAuth verification; does NOT certify migration history.
import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "tests/support/empty.ts") } },
  test: {
    include: ["tests/integration/mercadopago-oauth.test.ts"], environment: "node", fileParallelism: false,
    globalSetup: ["tests/support/mercadopago-global-setup.ts"], testTimeout: 30000,
    env: { NODE_ENV: "test", DATABASE_URL: "postgresql://mp_oauth_test:mp_test_only@localhost:5436/mp_oauth_test", APP_URL: "http://localhost:3000", AUTH_SECRET: "test-only-auth-secret-0123456789", DATA_ENCRYPTION_KEY: "test-only-data-encryption", CRON_SECRET: "test-only-cron", PAYMENT_PROVIDER: "simulated", SETTLEMENT_ENABLED: "false", EMAIL_PROVIDER: "console", MERCADO_PAGO_CLIENT_ID: "test-client", MERCADO_PAGO_CLIENT_SECRET: "test-only-client-secret", MERCADO_PAGO_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") },
  },
});
