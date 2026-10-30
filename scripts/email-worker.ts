import "dotenv/config";
import { db } from "../src/server/db";
import { dispatchEmailOutbox } from "../src/server/email/outbox";
const watch = process.argv.includes("--watch");
let stop = false;
process.on("SIGINT", () => {
  stop = true;
});
process.on("SIGTERM", () => {
  stop = true;
});
try {
  do {
    const result = await dispatchEmailOutbox(db, { limit: 20 });
    console.log(JSON.stringify(result));
    if (watch && !stop)
      await new Promise((resolve) => setTimeout(resolve, 10_000));
  } while (watch && !stop);
} catch {
  console.error(
    "Falha no processamento de e-mails. Verifique configuração e conectividade.",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
