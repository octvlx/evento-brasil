import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { EventAdminActions } from "@/features/admin/entity-actions";
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
  await requireAdmin("events:moderate");
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
            <Link href={`/admin/eventos/${e.id}`} className="hover:underline">
              {e.title}
            </Link>{" "}
            <Badge variant={st.tone === "success" ? "success" : st.tone === "warning" ? "warning" : st.tone === "danger" ? "danger" : "default"}>{st.label}</Badge>
            {e.isFeatured && <Badge variant="accent" className="ml-1">Destaque</Badge>}
            {e.suspendedAt && <Badge variant="danger" className="ml-1">Suspenso</Badge>}
          </p>
          {e.suspendedAt && <p className="text-xs text-destructive">Suspenso: {e.suspensionReason}</p>}
          <p className="text-xs text-muted-foreground">
            {e.organization.name} · {formatEventDateTime(e.startsAt, e.timezone)} · {e.city ? `${e.city.name} – ${e.city.state}` : "Online"} · {e.ticketTypes.reduce((s, t) => s + t.quantitySold, 0)} vendidos
          </p>
        </div>
        <EventAdminActions e={{ id: e.id, status, rawStatus: e.status, suspendedAt: e.suspendedAt, isFeatured: e.isFeatured }} />
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
