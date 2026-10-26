import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { AppError } from "@/server/errors";
import { attendeesToCsv, listAttendees } from "@/server/services/reports";
import { audit } from "@/server/audit";

export async function GET(_req: Request, ctx: RouteContext<"/api/organizador/eventos/[id]/participantes">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  try {
    const rows = await listAttendees(db, user, id);
    const event = await db.event.findUniqueOrThrow({ where: { id }, select: { slug: true, organizationId: true } });
    // Exportação de dados pessoais fica registrada (LGPD).
    await audit(db, { actorUserId: user.id, organizationId: event.organizationId, action: "attendees.exported", entityType: "Event", entityId: id, metadata: { rows: rows.length } });
    return new Response(attendeesToCsv(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="participantes-${event.slug}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return new Response("Acesso negado", { status: 403 });
    throw err;
  }
}
