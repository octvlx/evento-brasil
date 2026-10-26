// Auxiliar do INICIAR-EVENTO-BRASIL.bat (sem dependências além de `pg` e `dotenv`).
//   node scripts/setup-helper.mjs wait-db         → aguarda o PostgreSQL (até 90 s)
//   node scripts/setup-helper.mjs needs-seed      → exit 0 se o banco ainda não tem dados
//   node scripts/setup-helper.mjs wait-http URL   → aguarda a URL responder (até 4 min)
import "dotenv/config";

const [cmd, arg] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withClient(fn) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

switch (cmd) {
  case "wait-db": {
    for (let i = 0; i < 90; i++) {
      try {
        await withClient((c) => c.query("SELECT 1"));
        process.exit(0);
      } catch {
        await sleep(1000);
      }
    }
    process.exit(1);
    break;
  }
  case "needs-seed": {
    try {
      const { rows } = await withClient((c) => c.query('SELECT COUNT(*)::int AS n FROM "User"'));
      process.exit(rows[0].n === 0 ? 0 : 1);
    } catch {
      process.exit(0); // tabela ainda não existe
    }
    break;
  }
  case "wait-http": {
    for (let i = 0; i < 240; i++) {
      try {
        const res = await fetch(arg);
        if (res.status < 500) process.exit(0);
      } catch {
        // servidor ainda iniciando
      }
      await sleep(1000);
    }
    process.exit(1);
    break;
  }
  default:
    console.error(`Comando desconhecido: ${cmd}`);
    process.exit(2);
}
