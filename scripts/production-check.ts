// Verificação antes do deploy de produção. Uso:
//   npm run deploy:check                          (variáveis do ambiente atual)
//   npm run deploy:check -- --env-file=.env.production
//   npm run deploy:check -- --sem-banco           (só configuração)
// Não lê o .env de desenvolvimento por conta própria e nunca imprime valores, só nomes.
// Sai com código 1 se algum item bloquear o deploy.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";
import { checkProductionDb, checkProductionEnv, hasFailures, type CheckItem } from "../src/lib/production-check";

const args = process.argv.slice(2);
const envFile = args.find((a) => a.startsWith("--env-file="))?.slice("--env-file=".length);
const skipDb = args.includes("--sem-banco");

if (envFile) Object.assign(process.env, parse(readFileSync(envFile)));
// A validação do próprio app (src/server/env.ts) é a de produção.
(process.env as Record<string, string>).NODE_ENV = "production";

const ICON = { ok: "✓", warn: "!", fail: "✗" } as const;
function print(section: string, items: CheckItem[]) {
  console.log(`\n${section}`);
  for (const i of items) console.log(`  ${ICON[i.level]} ${i.title}${i.detail ? ` — ${i.detail}` : ""}`);
}

async function startupCheck(): Promise<CheckItem> {
  try {
    const { env } = await import("../src/server/env");
    env();
    return { level: "ok", title: "Validação de inicialização do app" };
  } catch (e) {
    // As mensagens de env() citam só nomes de variáveis.
    return { level: "fail", title: "Validação de inicialização do app", detail: e instanceof Error ? e.message : "falhou" };
  }
}

async function dbCheck(): Promise<CheckItem[]> {
  const { createPrismaClient } = await import("../src/server/db");
  const db = createPrismaClient();
  try {
    const applied = await db.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`;
    const done = new Set(applied.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name));
    const failed = applied.filter((m) => !m.finished_at && !m.rolled_back_at).map((m) => m.migration_name);
    const local = readdirSync(path.join(import.meta.dirname, "../prisma/migrations"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const [demoAccounts, activeAdmins, adminsWithoutMfa, cities] = await Promise.all([
      db.user.count({ where: { isDemoAccount: true, anonymizedAt: null } }),
      db.user.count({ where: { platformRole: "ADMIN", status: "ACTIVE", anonymizedAt: null } }),
      db.user.count({ where: { platformRole: "ADMIN", status: "ACTIVE", anonymizedAt: null, totpEnabledAt: null } }),
      db.city.count(),
    ]);
    return checkProductionDb({ pendingMigrations: local.filter((m) => !done.has(m)), failedMigrations: failed, demoAccounts, activeAdmins, adminsWithoutMfa, cities });
  } catch {
    return [{ level: "fail", title: "Banco de dados", detail: "não foi possível conectar ou consultar (confira DATABASE_URL e se as migrações já foram aplicadas)" }];
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  console.log(`Verificação de produção${envFile ? ` (${path.basename(envFile)})` : ""}`);
  const config = [await startupCheck(), ...checkProductionEnv(process.env)];
  print("Configuração", config);
  const data = skipDb ? [] : await dbCheck();
  if (!skipDb) print("Banco de dados", data);
  const all = [...config, ...data];
  const fails = all.filter((i) => i.level === "fail").length;
  const warns = all.filter((i) => i.level === "warn").length;
  console.log(`\n${fails ? `✗ ${fails} bloqueio(s)` : "✓ Nenhum bloqueio"}${warns ? `, ${warns} aviso(s)` : ""}.`);
  if (!fails) console.log("Itens manuais restantes: docs/deploy-producao.md.");
  process.exitCode = hasFailures(all) ? 1 : 0;
}

void main();
