import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { AppError } from "@/server/errors";
import { exportCheckinHistory, parseCheckinHistoryFilters } from "@/server/services/checkin";
import { checkinHistoryToCsv } from "@/server/services/reports";

// CSV do histórico do check-in com os filtros da tela (quem vê todas as leituras do
// evento). A exportação fica registrada como checkin.history_exported.
export async function GET(req: Request, ctx: RouteContext<"/check-in/[eventId]/historico/csv">) {
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  const { eventId } = await ctx.params;
  const filters = parseCheckinHistoryFilters(Object.fromEntries(new URL(req.url).searchParams));
  try {
    const { items, truncated, timezone, slug } = await exportCheckinHistory(db, user, eventId, filters);
    return new Response(checkinHistoryToCsv(items, timezone, truncated), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="check-in-${slug}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND" || err.code === "MFA_REQUIRED")) return new Response("Acesso negado", { status: 403 });
    throw err;
  }
}
