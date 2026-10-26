import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CalendarDays, Ticket } from "lucide-react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { EventCover } from "@/components/site/event-cover";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { formatDateShort, formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { ORDER_STATUS, TICKET_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Meus ingressos", robots: { index: false } };

export default function MyTicketsPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">Meus ingressos</h1>
      <Suspense fallback={<Skeleton className="mt-6 h-64" />}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requireUser("/meus-ingressos");
  const now = new Date();
  const [tickets, orders] = await Promise.all([
    db.issuedTicket.findMany({
      where: { userId: user.id },
      include: { ticketType: { select: { name: true } }, event: { select: { id: true, title: true, slug: true, startsAt: true, endsAt: true, timezone: true, coverImageUrl: true } } },
      orderBy: { event: { startsAt: "asc" } },
    }),
    db.order.findMany({ where: { userId: user.id }, include: { event: { select: { title: true } } }, orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  const byEvent = new Map<string, typeof tickets>();
  for (const t of tickets) byEvent.set(t.event.id, [...(byEvent.get(t.event.id) ?? []), t]);
  const groups = [...byEvent.values()];
  const upcoming = groups.filter((g) => g[0].event.endsAt >= now);
  const past = groups.filter((g) => g[0].event.endsAt < now);

  if (!tickets.length && !orders.length) {
    return (
      <div className="mt-10 rounded-3xl border border-dashed border-border p-10 text-center">
        <Ticket className="mx-auto size-10 text-secondary" aria-hidden />
        <p className="mt-3 font-semibold">Você ainda não tem ingressos.</p>
        <Link href="/eventos" className={buttonVariants({ variant: "secondary", className: "mt-4" })}>
          Explorar eventos
        </Link>
      </div>
    );
  }

  const Group = ({ g }: { g: typeof tickets }) => (
    <li className="overflow-hidden rounded-2xl border border-border bg-card sm:flex">
      <div className="aspect-[16/9] sm:aspect-auto sm:w-48">
        <EventCover src={g[0].event.coverImageUrl} alt="" />
      </div>
      <div className="flex-1 p-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-secondary">
          <CalendarDays className="size-3.5" aria-hidden /> {formatEventDateTime(g[0].event.startsAt, g[0].event.timezone)}
        </p>
        <h3 className="mt-1 font-display text-lg font-bold">{g[0].event.title}</h3>
        <ul className="mt-3 flex flex-wrap gap-2">
          {g.map((t) => {
            const s = TICKET_STATUS[t.status];
            return (
              <li key={t.id}>
                <Link href={`/ingressos/${t.code}`} className="flex items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm hover:border-secondary">
                  <Ticket className="size-4 text-secondary" aria-hidden /> {t.ticketType.name}
                  <Badge variant={s.tone === "success" ? "success" : s.tone === "danger" ? "danger" : "default"}>{s.label}</Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </li>
  );

  return (
    <div className="mt-6 space-y-10">
      <section>
        <h2 className="mb-3 font-display text-xl font-bold">Próximos</h2>
        {upcoming.length ? <ul className="space-y-4">{upcoming.map((g) => <Group key={g[0].event.id} g={g} />)}</ul> : <p className="text-muted-foreground">Nenhum ingresso para eventos futuros.</p>}
      </section>
      {past.length > 0 && (
        <section>
          <h2 className="mb-3 font-display text-xl font-bold">Anteriores</h2>
          <ul className="space-y-4 opacity-80">{past.map((g) => <Group key={g[0].event.id} g={g} />)}</ul>
        </section>
      )}
      <section>
        <h2 className="mb-3 font-display text-xl font-bold">Histórico de pedidos</h2>
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Pedido</th>
                <th className="p-3">Evento</th>
                <th className="p-3">Data</th>
                <th className="p-3">Total</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="p-3">
                    <Link href={`/pedido/${o.id}`} className="font-mono font-semibold text-secondary hover:underline">
                      {o.publicCode}
                    </Link>
                  </td>
                  <td className="p-3">{o.event.title}</td>
                  <td className="p-3">{formatDateShort(o.createdAt)}</td>
                  <td className="p-3 tabular-nums">{formatBRL(o.totalCents)}</td>
                  <td className="p-3">{ORDER_STATUS[o.status].label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
