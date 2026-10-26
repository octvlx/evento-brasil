// Resumo rápido do banco de desenvolvimento: npx tsx --conditions=react-server scripts/db-summary.ts
import "dotenv/config";
import { createPrismaClient } from "@/server/db";

async function main() {
  const db = createPrismaClient();
  const [orders, tickets, refunds, ledger, inventory] = await Promise.all([
    db.order.groupBy({ by: ["status"], _count: true, _sum: { totalCents: true } }),
    db.issuedTicket.groupBy({ by: ["status"], _count: true }),
    db.refund.groupBy({ by: ["status"], _count: true }),
    db.financialLedgerEntry.groupBy({ by: ["direction"], _sum: { amountCents: true } }),
    db.ticketType.aggregate({ _sum: { quantitySold: true, quantityReserved: true, quantityRefunded: true } }),
  ]);
  console.log(JSON.stringify({ orders, tickets, refunds, ledger, inventory }));
  await db.$disconnect();
}

main();
