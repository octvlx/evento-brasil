// Prepara um PostgreSQL instalado como serviço (instalador oficial, Docker etc.) para o
// desenvolvimento, no lugar do PostgreSQL embutido de `npm run db:start`.
// Uso: npm run db:setup-service   (pede a senha do superusuário "postgres")
//
// Cria (ou atualiza a senha de) o usuário e o banco da DATABASE_URL do .env, com
// collation C como o cluster embutido, fuso padrão America/Sao_Paulo no banco e, com
// --testes, os bancos descartáveis das suítes (evento_test e evento_e2e). Nunca
// imprime senhas nem a DATABASE_URL. Recusa host que não seja local e NODE_ENV=production.
import "dotenv/config";
import readline from "node:readline";
import pg from "pg";

if (process.env.NODE_ENV === "production") {
  console.error("pg-service-setup é apenas para desenvolvimento.");
  process.exit(1);
}
const url = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
  console.error("A DATABASE_URL não aponta para localhost: nada foi feito.");
  process.exit(1);
}
const port = Number(url.port || 5432);
const app = { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) };
const withTests = process.argv.includes("--testes");

function askHidden(question) {
  if (process.env.PG_SUPERUSER_PASSWORD) return Promise.resolve(process.env.PG_SUPERUSER_PASSWORD);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const superPassword = await askHidden(`Senha do superusuário "postgres" (localhost:${port}): `);
const admin = new pg.Client({ host: "localhost", port, user: "postgres", password: superPassword, database: "postgres" });
try {
  await admin.connect();
} catch (e) {
  console.error(`Não foi possível conectar como "postgres" em localhost:${port}: ${e.message}`);
  console.error("Confira se o serviço está rodando, a porta escolhida na instalação e a senha.");
  process.exit(1);
}

const ident = (s) => `"${s.replace(/"/g, '""')}"`;

async function ensureRole(user, password) {
  const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user])).rowCount > 0;
  const literal = admin.escapeLiteral(password);
  await admin.query(`${exists ? "ALTER" : "CREATE"} ROLE ${ident(user)} WITH LOGIN PASSWORD ${literal}`);
  console.log(`${exists ? "Senha atualizada" : "Usuário criado"}: ${user}`);
}

async function ensureDatabase(database, owner, { timezone } = {}) {
  const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database])).rowCount > 0;
  if (!exists) {
    // Collation C como o cluster embutido (initdb --locale=C): a ordenação e a paginação
    // por texto dependem dela (docs/database.md).
    await admin.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(owner)} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
    console.log(`Banco criado: ${database}`);
  } else {
    console.log(`Banco já existia: ${database} (não alterado)`);
  }
  if (timezone) await admin.query(`ALTER DATABASE ${ident(database)} SET timezone TO ${admin.escapeLiteral(timezone)}`);
}

await ensureRole(app.user, app.password);
await ensureDatabase(app.database, app.user, { timezone: "America/Sao_Paulo" });

if (withTests) {
  // Mesmas credenciais da CI (vitest.config.mts): não são segredos.
  await ensureRole("evento_test", "evento_test_pw");
  await ensureDatabase("evento_test", "evento_test");
  await ensureRole("evento_e2e", "evento_e2e_pw");
  await ensureDatabase("evento_e2e", "evento_e2e");
}
await admin.end();

console.log(`
Pronto. Próximos passos:
  npm run db:deploy      (aplica as migrações)
  npm run db:seed        (dados de demonstração)
Não rode \`npm run db:start\` enquanto o serviço estiver na mesma porta.${
  withTests
    ? `
Testes contra o serviço (bancos descartáveis: a suíte APAGA os dados deles):
  TEST_DATABASE_URL=postgresql://evento_test:evento_test_pw@localhost:${port}/evento_test
  E2E_DATABASE_URL=postgresql://evento_e2e:evento_e2e_pw@localhost:${port}/evento_e2e`
    : ""
}`);
