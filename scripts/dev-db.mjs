// PostgreSQL local SEM Docker (somente desenvolvimento).
// Com Docker disponível, prefira `docker compose up -d`.
// Uso: npm run db:start   (mantém o processo ativo; Ctrl+C para parar)
import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { ensureDatabase, localStateDir, startLocalPostgres } from "./pg-local.mjs";

if (process.env.NODE_ENV === "production") {
  console.error("dev-db.mjs é apenas para desenvolvimento.");
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL ?? "");
const cfg = {
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
};
// Diretório curto fora do projeto (limite de 260 caracteres do Windows) e fora
// de os.tmpdir(), que o Windows limpa sozinho.
const legacyDir = path.join(os.tmpdir(), "evento-brasil-pgdata", String(cfg.port));
let dataDir = process.env.DEV_PG_DATA_DIR ?? path.join(localStateDir(), "pgdata", String(cfg.port));
if (!process.env.DEV_PG_DATA_DIR && !existsSync(path.join(dataDir, "PG_VERSION")) && existsSync(path.join(legacyDir, "PG_VERSION"))) {
  // Não cria um banco vazio por cima de um cluster antigo: avisa e continua usando-o.
  console.warn(`Aviso: o banco local ainda está em ${legacyDir}, dentro da pasta temporária.`);
  console.warn(`A limpeza do sistema pode apagar arquivos dele. Veja "Banco fora da pasta temporária" em docs/database.md.`);
  dataDir = legacyDir;
}

const pg = await startLocalPostgres({ dataDir, ...cfg });
await ensureDatabase(cfg);
if (pg.alreadyRunning) {
  console.log(`PostgreSQL já está em execução em localhost:${cfg.port}/${cfg.database} — nada a fazer.`);
  process.exit(0);
}
console.log(`PostgreSQL de desenvolvimento ativo em localhost:${cfg.port}/${cfg.database}`);
console.log(`Dados em ${dataDir}`);

const shutdown = () => {
  pg.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
setInterval(() => {}, 1 << 30);
