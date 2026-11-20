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

// Já existe um banco respondendo na porta do .env (PostgreSQL instalado como serviço,
// Docker ou outro terminal): não sobe o embutido por cima (docs/database.md).
const existing = await probeDatabase();
if (existing.ok) {
  console.log(`Banco já respondendo em localhost:${cfg.port}/${cfg.database} (${existing.server}) — nada a fazer.`);
  process.exit(0);
}
if (existing.portInUse) {
  console.error(`Já há um servidor em localhost:${cfg.port}, mas a DATABASE_URL não conectou: ${existing.message}`);
  console.error("Se for o PostgreSQL instalado como serviço, rode `npm run db:setup-service`. Se não, troque a porta da DATABASE_URL.");
  process.exit(1);
}

async function probeDatabase() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    const { rows } = await client.query("SELECT split_part(version(), ',', 1) AS v");
    return { ok: true, server: rows[0].v };
  } catch (e) {
    // Recusa de conexão = porta livre (sobe o embutido); qualquer outra resposta = alguém escuta lá.
    const refused = e?.code === "ECONNREFUSED" || e?.errors?.every?.((x) => x.code === "ECONNREFUSED");
    return { ok: false, portInUse: !refused, message: e?.message ?? String(e) };
  } finally {
    await client.end().catch(() => {});
  }
}
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
