import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { AdminActionButton } from "@/features/admin/controls";
import { adminCancelEventAction, featureEventAction, moderateEventAction } from "@/features/admin/actions";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { formatEventDateTime } from "@/lib/datetime";
import { EVENT_STATUS } from "@/lib/labels";
import { effectiveEventStatus } from "@/lib/event-lifecycle";

export const metadata: Metadata = { title: "Eventos — admin", robots: { index: false } };

export default function AdminEvents() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  await requireAdmin();
  const events = await db.event.findMany({
    include: { organization: { select: { name: true } }, city: true, ticketTypes: { select: { quantitySold: true } } },
    orderBy: [{ status: "asc" }, { startsAt: "asc" }],
    take: 200,
  });
  const queue = events.filter((e) => e.status === "PENDING_REVIEW");
  const Row = ({ e }: { e: (typeof events)[number] }) => {
    // Término passado: Encerrado, sem destacar nem cancelar, mesmo antes do job.
    const status = effectiveEventStatus(e);
    const st = EVENT_STATUS[status];
    return (
      <li className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div>
          <p className="font-semibold">
            {status === "PUBLISHED" || status === "COMPLETED" ? (
              <Link href={`/eventos/${e.slug}`} className="hover:underline">
                {e.title}
              </Link>
            ) : (
              e.title
            )}{" "}
            <Badge variant={st.tone === "success" ? "success" : st.tone === "warning" ? "warning" : st.tone === "danger" ? "danger" : "default"}>{st.label}</Badge>
            {e.isFeatured && <Badge variant="accent" className="ml-1">Destaque</Badge>}
          </p>
          <p className="text-xs text-muted-foreground">
            {e.organization.name} · {formatEventDateTime(e.startsAt, e.timezone)} · {e.city ? `${e.city.name} – ${e.city.state}` : "Online"} · {e.ticketTypes.reduce((s, t) => s + t.quantitySold, 0)} vendidos
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {e.status === "PENDING_REVIEW" && (
            <>
              <AdminActionButton label="Aprovar" variant="secondary" action={moderateEventAction.bind(null, e.id, "APPROVE")} />
              <AdminActionButton label="Devolver" askReason="O que precisa ser ajustado?" reasonRequired action={moderateEventAction.bind(null, e.id, "REJECT")} />
            </>
          )}
          {status === "PUBLISHED" && (
            <>
              <AdminActionButton label={e.isFeatured ? "Remover destaque" : "Destacar"} action={featureEventAction.bind(null, e.id, !e.isFeatured)} />
              <AdminActionButton
                label="Cancelar"
                variant="destructive"
                askReason="Motivo do cancelamento"
                reasonRequired
                confirm="Cancela o evento e reembolsa todos os pedidos pagos."
                action={adminCancelEventAction.bind(null, e.id)}
              />
            </>
          )}
        </div>
      </li>
    );
  };
  return (
    <>
      <PageTitle title="Eventos" subtitle={`${queue.length} aguardando moderação`} />
      <h2 className="mb-2 text-sm font-bold">Fila de moderação</h2>
      <ul className="mb-8 divide-y divide-border rounded-2xl border border-border bg-card">
        {queue.length ? queue.map((e) => <Row key={e.id} e={e} />) : <li className="p-4 text-sm text-muted-foreground">Nada para moderar.</li>}
      </ul>
      <h2 className="mb-2 text-sm font-bold">Todos os eventos</h2>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
        {events.filter((e) => e.status !== "PENDING_REVIEW").map((e) => (
          <Row key={e.id} e={e} />
        ))}
      </ul>
    </>
  );
}
