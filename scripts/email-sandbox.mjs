// Ferramenta local de auditoria. Nunca reutiliza DATABASE_URL ou bancos existentes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { ensureDatabase, startLocalPostgres } from "./pg-local.mjs";
const root = path.resolve(import.meta.dirname, "..");
const serveCheck = process.argv.includes("--serve-check");
const serve = process.argv.includes("--serve") || serveCheck;
const temporary = mkdtempSync(path.join(os.tmpdir(), "evento-email-audit-"));
const children = [];
let database;
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function cleanup() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    else child.kill("SIGTERM");
  }
  database?.stop();
  const target = path.resolve(temporary);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith("evento-email-audit-")
  )
    throw Error("Temporary cleanup refused");
  rmSync(target, { recursive: true, force: true });
}
try {
  const port = await freePort();
  let appPort = await freePort();
  while (appPort === port) appPort = await freePort();
  const password = randomBytes(24).toString("hex");
  const config = { port, user: "email_audit", password };
  database = await startLocalPostgres({
    dataDir: path.join(temporary, "pg"),
    ...config,
  });
  assert.equal(database.alreadyRunning, false);
  await ensureDatabase({ ...config, database: "email_audit" });
  const env = {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_URL: `postgresql://email_audit:${password}@127.0.0.1:${port}/email_audit`,
    APP_URL: `http://127.0.0.1:${appPort}`,
    APP_BASE_URL: `http://127.0.0.1:${appPort}`,
    AUTH_SECRET: randomBytes(32).toString("hex"),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    CRON_SECRET: randomBytes(16).toString("hex"),
    EMAIL_PROVIDER: "console",
    RESEND_API_KEY: "",
    EMAIL_API_KEY: "",
    EMAIL_FROM: "Evento Brasil <local@example.com>",
    PAYMENT_PROVIDER: "simulated",
    SIMULATED_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
    STORAGE_PROVIDER: "local",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  delete env.TEST_DATABASE_URL;
  delete env.E2E_ISOLATED;
  const run = (args, inherit = true) => {
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: inherit ? "inherit" : "pipe",
    });
    if (result.status !== 0)
      throw Error(
        "Audit child failed: " + args[0] + " (exit " + result.status + ")",
      );
    return result.stdout;
  };
  console.log(
    "Banco NOVO descartável: 127.0.0.1:" +
      port +
      "/email_audit; EMAIL_PROVIDER=console",
  );
  run(["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  const fixture = path.join(root, ".data/email-audit-fixture.ts");
  writeFileSync(
    fixture,
    `import {db} from '../src/server/db';\nimport {enqueueEmail} from '../src/server/email/outbox';\nconst message={subject:'Auditoria local',html:'<p>Mensagem de auditoria local</p>',text:'Mensagem de auditoria local'};\nasync function main(){try {for(const [dedupeKey,expiresAt] of [['audit-valid',undefined],['audit-expired',new Date(0)],['audit-retry',undefined]] as const)await enqueueEmail(db,{dedupeKey,template:'LOCAL_AUDIT',recipient:'audit@test.local',message,expiresAt});await db.emailOutbox.update({where:{dedupeKey:'audit-retry'},data:{status:'FAILED',firstAttemptAt:new Date(),errorCode:'TEST_FAILURE'}});} finally {await db.$disconnect();}}\nvoid main().catch(()=>{process.exitCode=1;});\n`,
  );
  run(["--conditions=react-server", "--import", "tsx", fixture]);
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const status = () =>
      run(
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "scripts/email-status.ts",
        ],
        false,
      );
    assert.match(status(), /QUEUED/);
    assert.match(status(), /FAILED/);
    run([
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/email-worker.ts",
    ]);
    const { rows } = await client.query(
      'SELECT id,"dedupeKey",status,"attemptCount","providerMessageId","messageEncrypted" FROM "EmailOutbox"',
    );
    const valid = rows.find((r) => r.dedupeKey === "audit-valid"),
      expired = rows.find((r) => r.dedupeKey === "audit-expired"),
      retry = rows.find((r) => r.dedupeKey === "audit-retry");
    assert.equal(valid.status, "SENT");
    assert.equal(valid.messageEncrypted, null);
    assert.match(valid.providerMessageId, /^console:/);
    assert.equal(expired.status, "CANCELLED");
    assert.equal(retry.status, "FAILED");
    run([
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/email-retry.ts",
      retry.id,
    ]);
    run([
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/email-worker.ts",
    ]);
    run([
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/email-worker.ts",
    ]);
    const { rows: final } = await client.query(
      'SELECT status,count(*)::int AS count FROM "EmailOutbox" GROUP BY status',
    );
    assert.equal(final.find((r) => r.status === "SENT")?.count, 2);
    assert.equal(final.find((r) => r.status === "CANCELLED")?.count, 1);
    console.log(status());
    console.log(
      "PASS: worker CLI, status, reinício sem duplicar e retry controlado; 2 SENT, 1 CANCELLED.",
    );
  } finally {
    await client.end();
  }
  if (serve) {
    run(["--conditions=react-server", "--import", "tsx", "prisma/seed.ts"]);
    children.push(
      spawn(
        process.execPath,
        [
          "node_modules/next/dist/bin/next",
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(appPort),
        ],
        { cwd: root, env, stdio: "inherit" },
      ),
    );
    children.push(
      spawn(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "scripts/email-worker.ts",
          "--watch",
        ],
        { cwd: root, env, stdio: "inherit" },
      ),
    );
    console.log(
      "\nSANDBOX: " +
        env.APP_URL +
        "\nConsole: " +
        path.join(root, ".data/outbox") +
        "\nCliente demo: cliente@demo.eventobrasil.test / Demo@2026!\nCtrl+C encerra apenas este sandbox. Seus bancos existentes ficam intactos.",
    );
    if (serveCheck) {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try {
          const response = await fetch(env.APP_URL + "/entrar", {
            signal: AbortSignal.timeout(5000),
          });
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(ready, true, "Sandbox application did not start");
      console.log("PASS: aplicação e worker iniciados em sandbox isolado.");
    } else
      await new Promise((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
        for (const child of children) child.once("exit", resolve);
      });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
