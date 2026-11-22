// Sobe um PostgreSQL real e descartável para os testes de integração e aplica
// as migrações. Com TEST_DATABASE_URL definido, usa o banco informado.
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDatabase, startLocalPostgres } from "../../scripts/pg-local.mjs";

export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? `postgresql://evento_test:evento_test_pw@localhost:${process.env.TEST_DB_PORT ?? 5434}/evento_test`);
  let stop: (() => void) | undefined;
  if (!process.env.TEST_DATABASE_URL) {
    const dataDir = path.join(os.tmpdir(), "evento-brasil-pgtest", String(process.pid));
    const cfg = { port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    const pg = await startLocalPostgres({ dataDir, ...cfg });
    stop = () => {
      pg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    };
    await ensureDatabase({ ...cfg, database: url.pathname.slice(1) });
  }
  // prisma.config.ts carrega o .env e prefere DATABASE_URL_UNPOOLED (Neon): sem sobrescrevê-la,
  // as migrações iam para o banco de desenvolvimento em vez do banco de teste.
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: url.toString(), DATABASE_URL_UNPOOLED: url.toString() } });
  return () => stop?.();
}
