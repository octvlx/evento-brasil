import { db } from "@/server/db";
import { getActiveMembership, getCurrentUser } from "@/server/auth/current";
import { AppError } from "@/server/errors";
import { audit } from "@/server/audit";
import { listSalesOrders, salesOrdersToCsv } from "@/server/services/reports";
import { parseSalesPeriod } from "@/features/reports/period";
import { ORDER_STATUS } from "@/lib/labels";

// CSV de vendas da organização ativa, com os mesmos filtros da tela (de, ate, evento).
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  const { active } = await getActiveMembership(user.id);
  if (!active) return new Response("Acesso negado", { status: 403 });
  const url = new URL(req.url);
  const period = parseSalesPeriod({ de: url.searchParams.get("de"), ate: url.searchParams.get("ate") });
  const eventId = url.searchParams.get("evento") || null;
  const organizationId = active.organizationId;
  try {
    const rows = await listSalesOrders(db, user, organizationId, { period, eventId });
    const event = eventId ? await db.event.findUnique({ where: { id: eventId }, select: { title: true, slug: true } }) : null;
    const br = (d: string) => d.split("-").reverse().join("/");
    const periodText = period.de || period.ate ? `${period.de ? br(period.de) : "início"} a ${period.ate ? br(period.ate) : "hoje"}` : "Todo o período";
    const generatedAt = new Date();
    // Exportação financeira fica registrada, como as demais.
    await audit(db, {
      actorUserId: user.id,
      organizationId,
      action: "sales_report.exported",
      entityType: "Organization",
      entityId: organizationId,
      metadata: { rows: rows.length, de: period.de || null, ate: period.ate || null, eventId },
    });
    const csv = salesOrdersToCsv(rows, {
      organization: active.organization.name,
      period: periodText,
      event: event?.title ?? null,
      generatedAt,
      statusLabel: (s) => ORDER_STATUS[s]?.label ?? s,
    });
    const name = ["vendas", event?.slug, period.de, period.ate].filter(Boolean).join("-");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return new Response("Acesso negado", { status: 403 });
    if (err instanceof AppError && err.code === "NOT_FOUND") return new Response("Evento não encontrado", { status: 404 });
    throw err;
  }
}
