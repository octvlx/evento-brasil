// Barra o build de PRODUÇÃO da Vercel quando o banco não tem todas as migrações do
// código (docs/deploy-vercel.md, "Nova versão"). Só lê `_prisma_migrations`: nunca
// aplica nada — migração em produção continua manual (`npm run db:deploy`), antes
// do merge. Sem isso, o deploy sobe e quebra com "column ... does not exist".
//
// Preview e local: só avisa. Emergência (banco fora do ar): SKIP_MIGRATION_CHECK=1.
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Compara as pastas de migração com as linhas de `_prisma_migrations`. */
export function migrationGaps(localNames, appliedRows) {
  const done = new Set(appliedRows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
  return {
    pending: localNames.filter((name) => !done.has(name)),
    failed: appliedRows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name),
  };
}

export function localMigrations(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

async function main() {
  const production = process.env.VERCEL_ENV === "production";
  if (process.env.SKIP_MIGRATION_CHECK === "1") {
    console.warn("[migrações] conferência PULADA (SKIP_MIGRATION_CHECK=1).");
    return;
  }
  if (!production) {
    console.log("[migrações] fora da produção da Vercel: conferência só em produção.");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrações] DATABASE_URL ausente no build de produção.");
    process.exit(1);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  let rows;
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    ({ rows } = await client.query('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"'));
    await client.query("ROLLBACK");
  } catch (error) {
    console.error(`[migrações] não foi possível consultar o banco: ${error instanceof Error ? error.message : error}`);
    console.error("[migrações] Se o banco estiver fora do ar e o deploy for urgente, use SKIP_MIGRATION_CHECK=1.");
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }

  const { pending, failed } = migrationGaps(localMigrations(path.join(import.meta.dirname, "../prisma/migrations")), rows);
  if (!pending.length && !failed.length) {
    console.log("[migrações] banco de produção em dia.");
    return;
  }
  if (pending.length) console.error(`[migrações] PENDENTES no banco de produção: ${pending.join(", ")}`);
  if (failed.length) console.error(`[migrações] COM FALHA no banco de produção: ${failed.join(", ")}`);
  console.error(
    "[migrações] Deploy barrado: o site continua na versão anterior. Aplique do computador local e refaça o deploy:\n" +
      "  npx dotenv run -f .env.production --override -- npm run db:deploy\n" +
      "  vercel redeploy ticket24.com.br --environment production",
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
