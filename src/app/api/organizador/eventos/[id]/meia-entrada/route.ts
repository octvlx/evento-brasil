import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { AppError } from "@/server/errors";
import { halfPriceReport, halfPriceReportToCsv } from "@/server/services/reports";
import { audit } from "@/server/audit";

export async function GET(_req: Request, ctx: RouteContext<"/api/organizador/eventos/[id]/meia-entrada">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  try {
    const report = await halfPriceReport(db, user, id);
    // Relatório de conformidade (meia-entrada): toda exportação fica registrada.
    await audit(db, { actorUserId: user.id, organizationId: report.event.organizationId, action: "half_price_report.exported", entityType: "Event", entityId: id });
    return new Response(halfPriceReportToCsv(report), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="meia-entrada-${report.event.slug}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return new Response("Acesso negado", { status: 403 });
    throw err;
  }
}
