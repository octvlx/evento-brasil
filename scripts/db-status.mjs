// Estado do banco (somente leitura): conectividade + `prisma migrate status`.
// Uso: npm run db:status
import { spawnSync } from "node:child_process";
import { dbTarget } from "./db-target.mjs";

const target = dbTarget();
console.log(`Banco: ${target.label}${target.isLocal ? " (local)" : " (REMOTO)"}`);

const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString: target.url.toString(), connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows } = await client.query("SHOW server_version");
  console.log(`Conexão OK — PostgreSQL ${rows[0].server_version}`);
} catch (e) {
  // ECONNREFUSED chega como AggregateError, com `message` vazio.
  console.error(`Sem conexão: ${e.message || e.code || e.errors?.[0]?.message || e}`);
  console.error("Inicie o banco local com `docker compose up -d` ou `npm run db:start`.");
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

// `migrate status` só lê; sai com código 1 se houver migrações pendentes ou divergentes.
const status = spawnSync("npx", ["prisma", "migrate", "status"], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(status.status ?? 1);
