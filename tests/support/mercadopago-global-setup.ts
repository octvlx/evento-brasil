import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDatabase, startLocalPostgres } from "../../scripts/pg-local.mjs";
export default async function setup() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "eb-mp-oauth-"));
  const cfg = { port: 5436, user: "mp_oauth_test", password: "mp_test_only" };
  const pg = await startLocalPostgres({ dataDir, ...cfg });
  const stop = () => { pg.stop(); rmSync(dataDir, { recursive: true, force: true }); };
  try {
    await ensureDatabase({ ...cfg, database: "mp_oauth_test" });
    const prisma = path.resolve("node_modules/prisma/build/index.js");
    const testEnv = { ...process.env, DATABASE_URL: "postgresql://mp_oauth_test:mp_test_only@localhost:5436/mp_oauth_test" };
    // Capture a fresh-database migration check independently of schema-only testing.
    try { execFileSync(process.execPath, [prisma, "migrate", "deploy"], { env: testEnv, stdio: "pipe" }); }
    catch { console.warn("Migration replay failed on the disposable OAuth database. Schema-only tests do not validate migrations."); }
    execFileSync(process.execPath, [prisma, "db", "push"], { env: testEnv, stdio: "pipe" });
    return stop;
  } catch (error) { stop(); throw error; }
}
