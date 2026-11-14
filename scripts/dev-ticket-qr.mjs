// Somente desenvolvimento: imprime o conteúdo do QR de um ingresso (para testar
// o leitor de check-in digitando o código). Uso: node scripts/dev-ticket-qr.mjs CODIGO
import "dotenv/config";
import { createHmac } from "node:crypto";
import pg from "pg";

if (process.env.NODE_ENV === "production") process.exit(1);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query('SELECT code, "tokenVersion", "legacyValidationToken", "eventId" FROM "IssuedTicket" WHERE code = $1', [process.argv[2]]);
await client.end();
if (!rows[0]) {
  console.error("Ingresso não encontrado");
  process.exit(1);
}
// Mesmo cálculo de ticketQrToken (src/server/services/tickets.ts): o banco guarda só o hash.
const t = rows[0];
const secret = process.env.QR_TOKEN_SECRET || "dev-only-qr-token-secret-0123456789";
const token = t.tokenVersion === 0 ? t.legacyValidationToken : createHmac("sha256", secret).update(`eb-qr:${t.code}:${t.tokenVersion}`).digest("base64url");
if (!token) {
  console.error("Ingresso já utilizado: o QR antigo não é mais guardado");
  process.exit(1);
}
console.log(JSON.stringify({ payload: `EB1:${t.code}:${token}`, eventId: t.eventId }));
