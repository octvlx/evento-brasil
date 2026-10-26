// APAGA o banco local de desenvolvimento, reaplica as migrações e roda o seed.
// Uso: npm run db:reset -- --yes   (acrescente --no-seed para só recriar o schema)
// Recusa NODE_ENV=production, hosts que não sejam locais e execução sem --yes.
import { spawnSync } from "node:child_process";
import { dbTarget } from "./db-target.mjs";

const args = new Set(process.argv.slice(2));
const target = dbTarget();
console.log(`Alvo: ${target.label}`);

if (process.env.NODE_ENV === "production") {
  console.error("Recusado: NODE_ENV=production.");
  process.exit(1);
}
if (!target.isLocal) {
  console.error(`Recusado: host "${target.host}" não é local (localhost, 127.0.0.1 ou ::1).`);
  process.exit(1);
}
if (!args.has("--yes")) {
  console.error("Isto APAGA todos os dados deste banco. Para confirmar: npm run db:reset -- --yes");
  process.exit(1);
}

const run = (...cmd) => {
  const r = spawnSync("npx", ["prisma", ...cmd], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("migrate", "reset", "--force");
if (!args.has("--no-seed")) run("db", "seed");
