import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { auditLogsToCsv, exportAuditLogs, parseAuditFilters } from "@/server/services/admin-oversight";

// CSV da auditoria com os mesmos filtros da tela. Mesma exigência da tela (admin com
// 2FA e permissão audit:read); a exportação fica registrada como audit.exported.
export async function GET(req: Request) {
  const admin = await requireAdmin("audit:read");
  const filters = parseAuditFilters(Object.fromEntries(new URL(req.url).searchParams));
  const { items, truncated } = await exportAuditLogs(db, admin, filters);
  const name = ["auditoria", filters.period?.de, filters.period?.ate].filter(Boolean).join("-");
  return new Response(auditLogsToCsv(items, truncated), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
