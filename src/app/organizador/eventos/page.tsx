import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Plus } from "lucide-react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { isWizardComplete, wizardProgressByEvent } from "@/server/services/event-wizard-progress";
import { firstIncompleteStep } from "@/features/organizer/wizard-steps";
import { formatEventDateTime } from "@/lib/datetime";
import { EVENT_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Eventos — organizador", robots: { index: false } };

export default function OrganizerEventsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const { org, can } = await requireOrganizer("/organizador/eventos");
  const events = await db.event.findMany({
    where: { organizationId: org.id },
    include: { ticketTypes: { select: { quantityTotal: true, quantitySold: true, quantityReserved: true } }, city: true, _count: { select: { tickets: { where: { status: "CHECKED_IN" } } } } },
    orderBy: { startsAt: "desc" },
  });
  // Rascunhos do assistente ainda incompletos: data provisória e link para continuar.
  const progress = await wizardProgressByEvent(db, events.filter((e) => e.status === "DRAFT").map((e) => e.id));
  return (
    <>
      <PageTitle
        title="Eventos"
        actions={
          can("event:write") && (
            <Link href="/organizador/eventos/novo" className={buttonVariants({ variant: "accent" })}>
              <Plus aria-hidden /> Novo evento
            </Link>
          )
        }
      />
      {events.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">Nenhum evento ainda. Crie o primeiro!</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Evento</th>
                <th className="p-3">Data</th>
                <th className="p-3">Status</th>
                <th className="p-3 text-right">Vendidos</th>
                <th className="p-3 text-right">Check-ins</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const sold = e.ticketTypes.reduce((s, t) => s + t.quantitySold, 0);
                const st = EVENT_STATUS[e.status];
                const p = progress.get(e.id);
                const resumeStep = p && !isWizardComplete(p) ? firstIncompleteStep(p.completed) : null;
                return (
                  <tr key={e.id} className="border-t border-border">
                    <td className="p-3">
                      <p className="font-semibold">{e.title}</p>
                      <p className="text-xs text-muted-foreground">{e.city ? `${e.city.name} – ${e.city.state}` : "Online"}</p>
                    </td>
                    <td className="p-3">{resumeStep && !p?.completed.includes(2) ? <span className="text-muted-foreground">A definir</span> : formatEventDateTime(e.startsAt, e.timezone)}</td>
                    <td className="p-3">
                      <Badge variant={st.tone === "success" ? "success" : st.tone === "warning" ? "warning" : st.tone === "danger" ? "danger" : "default"}>{st.label}</Badge>
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {sold}/{e.capacity}
                    </td>
                    <td className="p-3 text-right tabular-nums">{e._count.tickets}</td>
                    <td className="p-3 text-right">
                      {resumeStep ? (
                        <Link href={`/organizador/eventos/novo?evento=${e.id}&etapa=${resumeStep}`} className="font-semibold text-secondary hover:underline">
                          Continuar cadastro <span className="block text-xs font-normal text-muted-foreground">etapa {resumeStep} de 6</span>
                        </Link>
                      ) : (
                        <Link href={`/organizador/eventos/${e.id}/editar`} className="font-semibold text-secondary hover:underline">
                          Gerenciar
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
