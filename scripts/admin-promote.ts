// Cria o primeiro superadministrador da plataforma. Uso: npm run admin:promote -- pessoa@dominio.com.br
// A pessoa precisa ter se cadastrado no site e confirmado o e-mail. Só funciona enquanto
// não existir um superadministrador ativo; depois, use /admin/usuarios.
import "dotenv/config";
import { createPrismaClient } from "@/server/db";
import { bootstrapFirstAdmin } from "@/server/services/admin-bootstrap";
import { AppError } from "@/server/errors";

async function main() {
  const email = process.argv[2];
  if (!email || !email.includes("@")) {
    console.error("Uso: npm run admin:promote -- <e-mail da conta>");
    process.exitCode = 1;
    return;
  }
  const db = createPrismaClient();
  try {
    await bootstrapFirstAdmin(db, email);
    console.log("Pronto: a conta agora é superadministradora. No primeiro acesso ao painel, o 2FA será exigido.");
  } catch (e) {
    console.error(e instanceof AppError ? e.message : "Falha ao promover a conta. Verifique DATABASE_URL e a conectividade.");
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main();
