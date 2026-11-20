import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { auditQueueExport, cancellationQueueToCsv, listCancellationQueue, parseCancellationStatus, QUEUE_EXPORT_LIMIT } from "@/server/services/admin-oversight";

// CSV da fila de pedidos de cancelamento com os filtros da tela. Mesma permissão da
// tela; a exportação fica na auditoria (admin.queue_exported).
export async function GET(req: Request) {
  const admin = await requireAdmin("cancellations:decide");
  const sp = new URL(req.url).searchParams;
  const overdueOnly = sp.get("vencidos") === "1";
  const assignee = sp.get("responsavel") === "eu" ? "me" : sp.get("responsavel") === "ninguem" ? "none" : undefined;
  const status = parseCancellationStatus(sp.get("status"));
  const queue = await listCancellationQueue(db, admin, { status, overdueOnly, assignee, exportAll: true });
  const truncated = queue.total > QUEUE_EXPORT_LIMIT;
  await auditQueueExport(db, admin, "cancellations", { status: queue.status, overdueOnly, assignee }, queue.items.length, truncated);
  return csv(`cancelamentos-${queue.status.toLowerCase()}${overdueOnly ? "-vencidos" : ""}`, cancellationQueueToCsv(queue.items, truncated));
}

function csv(name: string, body: string) {
  return new Response(body, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, "cache-control": "private, no-store" },
  });
}
