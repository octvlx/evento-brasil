import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Download } from "lucide-react";
import { Badge, Select, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { listAttendees } from "@/server/services/reports";
import { formatDateTimeShort } from "@/lib/datetime";
import { TICKET_KIND, TICKET_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Participantes", robots: { index: false } };

export default function AttendeesPage({ searchParams }: PageProps<"/organizador/participantes">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<{ evento?: string }>} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: Promise<{ evento?: string }> }) {
  const { evento } = await searchParams;
  const { user, org, can } = await requireOrganizer("/organizador/participantes");
  if (!can("attendees:read")) redirect("/organizador");
  const events = await db.event.findMany({ where: { organizationId: org.id }, select: { id: true, title: true, timezone: true }, orderBy: { startsAt: "desc" } });
  const selected = events.find((e) => e.id === evento) ?? events[0];
  const rows = selected ? await listAttendees(db, user, selected.id) : [];
  return (
    <>
      <PageTitle
        title="Participantes"
        actions={
          selected && (
            <a href={`/api/organizador/eventos/${selected.id}/participantes`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Download aria-hidden /> Exportar CSV
            </a>
          )
        }
      />
      {events.length === 0 ? (
        <p className="text-muted-foreground">Nenhum evento.</p>
      ) : (
        <>
          <form className="mb-4 flex max-w-lg gap-2">
            <Select name="evento" defaultValue={selected?.id} aria-label="Evento">
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </Select>
            <button className={buttonVariants({ variant: "secondary" })}>Ver</button>
          </form>
          <p className="mb-3 text-sm text-muted-foreground">
            {rows.length} ingresso(s) · {rows.filter((r) => r.status === "CHECKED_IN").length} check-in(s)
          </p>
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Código</th>
                  <th className="p-3">Participante</th>
                  <th className="p-3">Ingresso</th>
                  <th className="p-3">Pedido</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Check-in</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const s = TICKET_STATUS[t.status];
                  return (
                    <tr key={t.id} className="border-t border-border">
                      <td className="p-3 font-mono">{t.code}</td>
                      <td className="p-3">
                        <p>{t.holderName}</p>
                        <p className="text-xs text-muted-foreground">{t.holderEmail}</p>
                      </td>
                      <td className="p-3">
                        {t.ticketType.name} <span className="text-xs text-muted-foreground">({TICKET_KIND[t.ticketType.kind]})</span>
                      </td>
                      <td className="p-3 font-mono">{t.order.publicCode}</td>
                      <td className="p-3">
                        <Badge variant={s.tone === "success" ? "success" : s.tone === "danger" ? "danger" : "default"}>{s.label}</Badge>
                      </td>
                      <td className="p-3">{t.checkedInAt ? formatDateTimeShort(t.checkedInAt, selected!.timezone) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
