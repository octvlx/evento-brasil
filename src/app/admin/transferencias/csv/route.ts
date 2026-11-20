import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { auditQueueExport, parseTransferStatus, QUEUE_EXPORT_LIMIT, searchTransfers, transfersToCsv } from "@/server/services/admin-oversight";

// CSV do histórico de transferências com a busca e o filtro da tela (auditado).
export async function GET(req: Request) {
  const admin = await requireAdmin("transfers:read");
  const sp = new URL(req.url).searchParams;
  const status = parseTransferStatus(sp.get("status"));
  const result = await searchTransfers(db, admin, { q: sp.get("q") ?? undefined, status, exportAll: true });
  const truncated = result.total > QUEUE_EXPORT_LIMIT;
  await auditQueueExport(db, admin, "transfers", { q: result.q || null, status: status ?? null }, result.items.length, truncated);
  return new Response(transfersToCsv(result.items, truncated), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="transferencias.csv"`, "cache-control": "private, no-store" },
  });
}
