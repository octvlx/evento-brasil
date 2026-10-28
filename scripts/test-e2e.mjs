// Browser suite with its own PostgreSQL and app; never seeds the developer DB.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ensureDatabase, startLocalPostgres } from "./pg-local.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

const dir = mkdtempSync(path.join(os.tmpdir(), "evento-brasil-e2e-"));
const root = path.resolve(import.meta.dirname, "..");
const nextEnvPath = path.join(root, "next-env.d.ts");
const previousNextEnv = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, "utf8") : null;
let pg;
try {
  mkdirSync(path.join(root, ".next"), { recursive: true });
  writeFileSync(path.join(root, ".next/tsconfig.e2e.json"), JSON.stringify({
    extends: "../tsconfig.json",
    include: ["../next-env.d.ts", "../src/**/*.ts", "../src/**/*.tsx", "./e2e/types/**/*.ts", "./e2e/dev/types/**/*.ts"],
    exclude: ["../node_modules"],
  }, null, 2));
  const dbPort = await freePort();
  let appPort = await freePort();
  while (appPort === dbPort) appPort = await freePort();
  const password = randomBytes(24).toString("hex");
  const cfg = { port: dbPort, user: "evento_e2e", password };
  pg = await startLocalPostgres({ dataDir: path.join(dir, "pg"), ...cfg });
  await ensureDatabase({ ...cfg, database: "evento_e2e" });
  const env = {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: `postgresql://evento_e2e:${password}@127.0.0.1:${dbPort}/evento_e2e`,
    APP_URL: `http://localhost:${appPort}`,
    E2E_BASE_URL: `http://localhost:${appPort}`,
    E2E_ISOLATED: "1",
    AUTH_SECRET: randomBytes(32).toString("hex"),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    CRON_SECRET: randomBytes(16).toString("hex"),
    PAYMENT_PROVIDER: "simulated",
    SIMULATED_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
    EMAIL_PROVIDER: "console",
    STORAGE_PROVIDER: "local",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const run = (args) => {
    const result = spawnSync(process.execPath, args, { env, stdio: "inherit", cwd: root });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`E2E subprocess failed (${result.status ?? result.signal}).`);
  };
  run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  run(["--conditions=react-server", "--import", "tsx", "prisma/seed.ts"]);
  run(["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)]);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  pg?.stop();
  if (previousNextEnv !== null && existsSync(nextEnvPath) && readFileSync(nextEnvPath, "utf8").includes(".next/e2e/")) {
    writeFileSync(nextEnvPath, previousNextEnv);
  }
  // Recursive removal is confined to the exact temporary directory we created.
  const target = path.resolve(dir);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("evento-brasil-e2e-")) {
    throw new Error("Refusing to remove a directory outside the isolated E2E temporary root.");
  }
  rmSync(target, { recursive: true, force: true });
}
