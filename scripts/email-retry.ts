import "dotenv/config";
import { db } from "../src/server/db";
import { retryFailedEmail } from "../src/server/email/outbox";
try {
  const id = process.argv[2];
  if (!id) throw Error();
  console.log(await retryFailedEmail(db, id));
} catch {
  console.error(
    "Retentativa recusada. Use um ID FAILED dentro da janela segura de23h e com conteúdo ainda disponível.",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
