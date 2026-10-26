// Somente desenvolvimento: imprime o conteúdo do QR de um ingresso (para testar
// o leitor de check-in digitando o código). Uso: node scripts/dev-ticket-qr.mjs CODIGO
import "dotenv/config";
import pg from "pg";

if (process.env.NODE_ENV === "production") process.exit(1);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query('SELECT code, "validationToken", "eventId" FROM "IssuedTicket" WHERE code = $1', [process.argv[2]]);
await client.end();
if (!rows[0]) {
  console.error("Ingresso não encontrado");
  process.exit(1);
}
console.log(JSON.stringify({ payload: `EB1:${rows[0].code}:${rows[0].validationToken}`, eventId: rows[0].eventId }));
