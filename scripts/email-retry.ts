import "dotenv/config";
import { db } from "../src/server/db";
import { retryFailedEmail } from "../src/server/email/outbox";
async function main() {
  try {
    const id = process.argv[2];
    if (!id) throw Error();
    console.log(await retryFailedEmail(db, id));
  } catch {
    console.error(
      "Retentativa recusada. Use um ID FAILED dentro da janela segura de 23h e com conteúdo ainda disponível.",
    );
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  console.error(
    "Falha na operação de e-mail. Verifique configuração e conectividade.",
  );
  process.exitCode = 1;
});
