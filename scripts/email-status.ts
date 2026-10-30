import "dotenv/config";
import { db } from "../src/server/db";
async function main() {
  try {
    console.table(
      await db.emailOutbox.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          template: true,
          provider: true,
          status: true,
          attemptCount: true,
          errorCode: true,
          sentAt: true,
          nextAttemptAt: true,
        },
      }),
    );
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
