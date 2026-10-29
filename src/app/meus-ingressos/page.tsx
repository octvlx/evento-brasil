import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ArrowRightLeft, CalendarDays, Inbox, Ticket } from "lucide-react";
import { Badge, Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { EventCover } from "@/components/site/event-cover";
import { CancelTransferButton, IncomingTransferActions, TransferForm } from "@/features/transfers/transfer-controls";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { listMyTransfers } from "@/server/services/transfers";
import { formatDateShort, formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { normalizeTransferPolicy, transferCutoff } from "@/lib/transfer-policy";
import { timezoneLabel } from "@/lib/datetime";
import { CANCEL_HELP_HREF } from "@/lib/help-links";
import { ORDER_STATUS, TICKET_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Meus ingressos", robots: { index: false } };

// `?transferir=<código>`: o botão "Transferir ingresso" da página do ingresso (check-in) abre o formulário daquele ingresso aqui.
export default function MyTicketsPage({ searchParams }: PageProps<"/meus-ingressos">) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">Meus ingressos</h1>
      <Suspense fallback={<Skeleton className="mt-6 h-64" />}>
        <Content searchParams={searchParams as Promise<{ transferir?: string | string[] }>} />
      </Suspense>
    </div>
  );
}

async function Content({ searchParams }: { searchParams: Promise<{ transferir?: string | string[] }> }) {
  const { transferir } = await searchParams;
  const preselect = typeof transferir === "string" ? transferir : null;
  const user = await requireUser(preselect ? `/meus-ingressos?transferir=${encodeURIComponent(preselect)}` : "/meus-ingressos");
  const now = new Date();
  const [tickets, orders, transfers] = await Promise.all([
    db.issuedTicket.findMany({
      where: { holderUserId: user.id },
      include: {
        ticketType: { select: { name: true } },
        order: { select: { status: true } },
        event: { select: { id: true, title: true, slug: true, startsAt: true, endsAt: true, timezone: true, coverImageUrl: true, status: true, transferDeadlineHours: true, transferMaxTransfers: true, transferAllowReturn: true } },
      },
      orderBy: { event: { startsAt: "asc" } },
    }),
    db.order.findMany({ where: { userId: user.id }, include: { event: { select: { title: true } } }, orderBy: { createdAt: "desc" }, take: 5 }),
    listMyTransfers(db, user),
  ]);
  // One batched count for all owned tickets; never expose other holders' details.
  const acceptedCounts = tickets.length ? await db.ticketTransfer.groupBy({
    by: ["ticketId"],
    where: { ticketId: { in: tickets.map((t) => t.id) }, status: "ACCEPTED" },
    _count: { _all: true },
  }) : [];
  const acceptedByTicket = new Map(acceptedCounts.map((t) => [t.ticketId, t._count._all]));
  const isOpen = (t: { status: string; effectiveExpiresAt: Date | null }) => t.status === "PENDING" && !!t.effectiveExpiresAt && t.effectiveExpiresAt > now;
  const outgoing = new Map(transfers.sent.filter(isOpen).map((t) => [t.ticket.id, t]));
  const incoming = transfers.received.filter(isOpen);
  const transferredAway = transfers.sent.filter((t) => t.status === "ACCEPTED");
  // Só decide se o botão aparece; o serviço reconfere tudo (inclusive o limite de transferências).
  const canTransfer = (t: (typeof tickets)[number]) => t.status === "VALID" && t.order.status === "PAID" && t.event.status === "PUBLISHED" && transferCutoff(t.event.startsAt, t.event) > now && (acceptedByTicket.get(t.id) ?? 0) < t.event.transferMaxTransfers;

  const byEvent = new Map<string, typeof tickets>();
  for (const t of tickets) byEvent.set(t.event.id, [...(byEvent.get(t.event.id) ?? []), t]);
  const groups = [...byEvent.values()];
  const upcoming = groups.filter((g) => g[0].event.endsAt >= now);
  const past = groups.filter((g) => g[0].event.endsAt < now);

  if (!tickets.length && !orders.length && !incoming.length && !transferredAway.length) {
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
      <div className="min-w-0 flex-1 p-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-secondary">
          <CalendarDays className="size-3.5" aria-hidden /> {formatEventDateTime(g[0].event.startsAt, g[0].event.timezone)}
        </p>
        <h3 className="mt-1 font-display text-lg font-bold">{g[0].event.title}</h3>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="transfer-policy-summary">
          Transferência gratuita: solicitação e aceite até {formatDateTimeShort(transferCutoff(g[0].event.startsAt, g[0].event), g[0].event.timezone)} ({timezoneLabel(transferCutoff(g[0].event.startsAt, g[0].event), g[0].event.timezone)}).
          {" "}Máximo de {g[0].event.transferMaxTransfers} {g[0].event.transferMaxTransfers === 1 ? "transferência aceita" : "transferências aceitas"} por ingresso.
          {" "}{g[0].event.transferAllowReturn ? "Devolução apenas por nova transferência com aceite, dentro do limite." : "Sem desfazer ou devolução após o aceite."}
        </p>
        <ul className="mt-3 space-y-2">
          {g.map((t) => {
            const s = TICKET_STATUS[t.status];
            const out = outgoing.get(t.id);
            return (
              <li key={t.id} id={`ingresso-${t.code}`} className="flex scroll-mt-24 flex-wrap items-center gap-2" data-testid="my-ticket">
                <Link href={`/ingressos/${t.code}`} className="flex items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm hover:border-secondary">
                  <Ticket className="size-4 text-secondary" aria-hidden /> {t.ticketType.name}
                  <Badge variant={s.tone === "success" ? "success" : s.tone === "danger" ? "danger" : "default"}>{s.label}</Badge>
                </Link>
                {out ? (
                  <span className="flex flex-wrap items-center gap-2 text-sm" data-testid="outgoing-transfer">
                    <Badge variant="warning">Transferência pendente</Badge>
                    <span className="text-muted-foreground">
                      para {out.toHolderName ?? out.toEmail} ({out.toEmail}), até {formatDateTimeShort(out.effectiveExpiresAt!, t.event.timezone)}
                    </span>
                    <CancelTransferButton transferId={out.id} />
                  </span>
                ) : (
                  canTransfer(t) ? (
                    <TransferForm
                      ticketId={t.id}
                      ticketLabel={`${t.ticketType.name} · ${t.event.title}`}
                      policy={normalizeTransferPolicy(t.event)}
                      startsAt={t.event.startsAt.toISOString()}
                      timezone={t.event.timezone}
                      defaultOpen={t.code === preselect}
                    />
                  ) : t.status === "VALID" && t.order.status === "PAID" && t.event.status === "PUBLISHED" ? (
                    <span className="text-xs text-muted-foreground" data-testid="transfer-unavailable">
                      {(acceptedByTicket.get(t.id) ?? 0) >= t.event.transferMaxTransfers ? "Limite de transferências atingido para este ingresso." : "Prazo para solicitar e aceitar transferências encerrado."}
                    </span>
                  ) : null
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </li>
  );

  return (
    <div className="mt-6 space-y-10">
      {incoming.length > 0 && (
        <section aria-labelledby="incoming-title">
          <h2 id="incoming-title" className="mb-3 flex items-center gap-2 font-display text-xl font-bold">
            <Inbox className="size-5 text-secondary" aria-hidden /> Transferências recebidas
          </h2>
          <ul className="space-y-3">
            {incoming.map((t) => (
              <li key={t.id}>
                <Card className="space-y-3 p-4" data-testid="incoming-transfer">
                  <p className="text-sm">
                    <strong>{t.fromHolderName}</strong> quer transferir para você um ingresso <strong>{t.ticket.ticketType.name}</strong> de <strong>{t.event.title}</strong> (
                    {formatEventDateTime(t.event.startsAt, t.event.timezone)}).
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Gratuito. Ao aceitar, o ingresso passa para o seu nome com um QR code novo. Responda até {formatDateTimeShort(t.effectiveExpiresAt!, t.event.timezone)}.
                  </p>
                  <IncomingTransferActions transferId={t.id} />
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
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
      {transferredAway.length > 0 && (
        <section aria-labelledby="transferred-title">
          <h2 id="transferred-title" className="mb-3 flex items-center gap-2 font-display text-xl font-bold">
            <ArrowRightLeft className="size-5 text-secondary" aria-hidden /> Transferidos por você
          </h2>
          <ul className="divide-y divide-border rounded-2xl border border-border">
            {transferredAway.map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-3 text-sm" data-testid="transferred-away">
                <span>
                  <strong>{t.ticket.ticketType.name}</strong> · {t.event.title}
                </span>
                <span className="text-muted-foreground">
                  para {t.toHolderName ?? t.toEmail} em {formatDateShort(t.decidedAt ?? t.createdAt)} · o QR code antigo não vale mais
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-bold">Últimos pedidos</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/meus-pedidos" className="text-sm font-semibold text-secondary hover:underline">
              Ver todos os pedidos
            </Link>
            <Link href={CANCEL_HELP_HREF} className="text-sm font-semibold text-secondary hover:underline">
              Cancelar compra / arrependimento
            </Link>
          </div>
        </div>
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
                  <td className="p-3">
                    <Badge variant={ORDER_STATUS[o.status].tone}>
                      {ORDER_STATUS[o.status].label}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
