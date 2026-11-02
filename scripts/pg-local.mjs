// Inicia um PostgreSQL real local usando os binários oficiais distribuídos
// pelo pacote `embedded-postgres` (somente desenvolvimento/testes).
//
// No Windows, executáveis em caminhos com mais de 260 caracteres não podem ser
// iniciados; por isso os binários são copiados uma vez para um diretório curto
// em localStateDir() quando o projeto está num caminho longo.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Diretório curto e persistente para o PostgreSQL local. Nunca os.tmpdir():
 * a limpeza de temporários do Windows apaga arquivos do cluster e corrompe o banco.
 */
export function localStateDir() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "evento-brasil");
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "evento-brasil");
}

function nativeDir() {
  const pkg = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const pkgDir = path.join(import.meta.dirname, "..", "node_modules", ...pkg.split("/"));
  const dir = path.join(pkgDir, "native");
  if (process.platform !== "win32" || dir.length < 180) return dir;
  const version = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
  const shortDir = path.join(localStateDir(), "pg", version);
  if (!existsSync(path.join(shortDir, "bin", "pg_ctl.exe"))) {
    mkdirSync(shortDir, { recursive: true });
    cpSync(dir, shortDir, { recursive: true });
  }
  return shortDir;
}

const exe = (dir, name) => path.join(dir, "bin", process.platform === "win32" ? `${name}.exe` : name);

/**
 * @param {{ dataDir: string, port: number, user: string, password: string, log?: string }} opts
 * @returns {Promise<{ alreadyRunning: boolean, stop: () => void }>}
 */
export async function startLocalPostgres({ dataDir, port, user, password, log }) {
  const bin = nativeDir();
  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    mkdirSync(dataDir, { recursive: true });
    const pwfile = path.join(os.tmpdir(), `eb-pw-${process.pid}-${Date.now()}`);
    writeFileSync(pwfile, password);
    const init = spawnSync(
      exe(bin, "initdb"),
      [`--pgdata=${dataDir}`, "--auth=scram-sha-256", `--username=${user}`, `--pwfile=${pwfile}`, "--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      { encoding: "utf8" },
    );
    rmSync(pwfile, { force: true });
    if (init.status !== 0) throw new Error(`initdb falhou: ${init.stderr || init.error}`);
  }
  // Já em execução (ex.: iniciado em outro terminal): reutiliza sem parar depois.
  if (spawnSync(exe(bin, "pg_ctl"), ["status", "-D", dataDir], { stdio: "ignore" }).status === 0) {
    return { alreadyRunning: true, stop() {} };
  }
  const logFile = log ?? path.join(dataDir, "..", `pg-${port}.log`);
  // stdio "ignore": o postgres daemonizado herdaria os pipes e o spawnSync
  // nunca retornaria. A saída do servidor vai para `logFile`.
  const start = spawnSync(
    exe(bin, "pg_ctl"),
    ["start", "-w", "-D", dataDir, "-l", logFile, "-o", `-p ${port} -c listen_addresses=localhost -c max_connections=200`],
    { stdio: "ignore" },
  );
  if (start.status !== 0) throw new Error(`pg_ctl start falhou (código ${start.status}); veja ${logFile}`);
  return {
    alreadyRunning: false,
    stop() {
      spawnSync(exe(bin, "pg_ctl"), ["stop", "-D", dataDir, "-m", "fast"], { stdio: "ignore" });
    },
  };
}

/** Cria o banco se não existir, usando o driver `pg`. */
export async function ensureDatabase({ port, user, password, database }) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ host: "localhost", port, user, password, database: "postgres" });
  await client.connect();
  const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (!rowCount) await client.query(`CREATE DATABASE "${database.replace(/"/g, "")}"`);
  await client.end();
}
