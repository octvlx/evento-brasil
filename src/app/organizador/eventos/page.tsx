import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Plus } from "lucide-react";
import { Badge, Input, Select, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { Pager } from "@/features/admin/pager";
import { listOrganizationEventsPage, ORGANIZER_EVENT_FILTERS, type OrganizerEventFilter } from "@/server/services/events";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { isWizardComplete, wizardProgressByEvent } from "@/server/services/event-wizard-progress";
import { firstIncompleteStep } from "@/features/organizer/wizard-steps";
import { formatEventDateTime } from "@/lib/datetime";
import { EVENT_STATUS } from "@/lib/labels";
import { effectiveEventStatus } from "@/lib/event-lifecycle";

export const metadata: Metadata = { title: "Eventos — organizador", robots: { index: false } };

export default function OrganizerEventsPage({ searchParams }: PageProps<"/organizador/eventos">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<Params>} />
    </Suspense>
  );
}

type Params = { q?: string; status?: string; pagina?: string };
const PATH = "/organizador/eventos";

async function Content({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { user, org, can } = await requireOrganizer("/organizador/eventos");
  const status = ORGANIZER_EVENT_FILTERS.find((s) => s === sp.status) as OrganizerEventFilter | undefined;
  const list = await listOrganizationEventsPage(db, user, org.id, { q: typeof sp.q === "string" ? sp.q : "", status, page: Number(sp.pagina) || 1 });
  const events = list.rows;
  const filtered = !!(list.q || status);
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
      {list.all > 0 && (
        <form className="mb-4 flex flex-wrap items-end gap-2" role="search" aria-label="Buscar eventos">
          <Input name="q" defaultValue={list.q} placeholder="Nome do evento" aria-label="Buscar pelo nome do evento" className="min-w-0 basis-full sm:max-w-sm sm:flex-1 sm:basis-0" />
          <Select name="status" defaultValue={status ?? ""} aria-label="Situação" className="w-auto">
            <option value="">Todas as situações</option>
            {ORGANIZER_EVENT_FILTERS.map((s) => (
              <option key={s} value={s}>
                {EVENT_STATUS[s].label}
              </option>
            ))}
          </Select>
          <button className={buttonVariants({ variant: "secondary" })}>Filtrar</button>
          {filtered && (
            <Link href={PATH} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Limpar
            </Link>
          )}
        </form>
      )}
      {events.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">
          {filtered ? "Nenhum evento com esses filtros." : "Nenhum evento ainda. Crie o primeiro!"}
        </p>
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
                // Término passado aparece como Encerrado mesmo antes do job.
                const st = EVENT_STATUS[effectiveEventStatus(e)];
                const p = progress.get(e.id);
                const resumeStep = p && !isWizardComplete(p) ? firstIncompleteStep(p.completed) : null;
                return (
                  <tr key={e.id} className="border-t border-border">
                    <td className="p-3">
                      {resumeStep ? (
                        <p className="font-semibold">{e.title}</p>
                      ) : (
                        <Link href={`/organizador/eventos/${e.id}`} className="font-semibold hover:underline">
                          {e.title}
                        </Link>
                      )}
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
      {events.length > 0 && <Pager path={PATH} params={{ q: list.q || undefined, status }} page={list.page} pageCount={list.pageCount} total={list.total} />}
    </>
  );
}
