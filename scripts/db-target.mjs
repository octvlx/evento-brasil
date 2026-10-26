// Identifica o banco apontado por DATABASE_URL sem expor a senha.
import "dotenv/config";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** @returns {{ url: URL, host: string, port: number, database: string, user: string, isLocal: boolean, label: string }} */
export function dbTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("DATABASE_URL não definido (copie .env.example para .env).");
    process.exit(1);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error("DATABASE_URL inválido (esperado postgresql://usuario:senha@host:porta/banco).");
    process.exit(1);
  }
  const host = url.hostname;
  const port = Number(url.port || 5432);
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  return { url, host, port, database, user, isLocal: LOCAL_HOSTS.has(host), label: `${user}@${host}:${port}/${database}` };
}
