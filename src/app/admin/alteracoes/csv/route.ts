import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { auditQueueExport, changeWindowsToCsv, listOpenChangeWindows, QUEUE_EXPORT_LIMIT } from "@/server/services/admin-oversight";

// CSV das janelas de reembolso abertas por alteração relevante de evento (auditado).
export async function GET() {
  const admin = await requireAdmin("events:moderate");
  const result = await listOpenChangeWindows(db, admin, { exportAll: true });
  const truncated = result.total > QUEUE_EXPORT_LIMIT;
  await auditQueueExport(db, admin, "event_change_windows", {}, result.items.length, truncated);
  return new Response(changeWindowsToCsv(result.items, truncated), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="alteracoes-com-janela-aberta.csv"`, "cache-control": "private, no-store" },
  });
}
