import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { CalendarDays, ChevronRight, Receipt } from "lucide-react";
import type { OrderStatus, Prisma } from "@/generated/prisma/client";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { EventCover } from "@/components/site/event-cover";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { formatDateShort, formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { CANCEL_HELP_HREF } from "@/lib/help-links";
import { ORDER_STATUS } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Meus pedidos", robots: { index: false } };

const PAGE_SIZE = 15;

// Filtros por situação (agrupam os status do pedido).
const FILTERS: { value: string; label: string; statuses?: OrderStatus[] }[] = [
  { value: "", label: "Todos" },
  { value: "pagos", label: "Pagos", statuses: ["PAID"] },
  { value: "pendentes", label: "Aguardando pagamento", statuses: ["PENDING_PAYMENT"] },
  { value: "reembolsos", label: "Reembolsos", statuses: ["REFUND_PENDING", "REFUNDED"] },
  { value: "cancelados", label: "Cancelados", statuses: ["CANCELLED", "EXPIRED", "PAYMENT_FAILED"] },
];

type Search = { situacao?: string; pagina?: string };

export default function MyOrdersPage({ searchParams }: PageProps<"/meus-pedidos">) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-3xl font-extrabold tracking-tight">Meus pedidos</h1>
        <Link href={CANCEL_HELP_HREF} className="text-sm font-semibold text-secondary hover:underline">
          Cancelar compra / arrependimento
        </Link>
      </div>
      <Suspense fallback={<Skeleton className="mt-6 h-96" />}>
        <Orders searchParams={searchParams as Promise<Search>} />
      </Suspense>
    </div>
  );
}

const href = (situacao: string, pagina = 1) => {
  const p = new URLSearchParams();
  if (situacao) p.set("situacao", situacao);
  if (pagina > 1) p.set("pagina", String(pagina));
  const s = p.toString();
  return s ? `/meus-pedidos?${s}` : "/meus-pedidos";
};

async function Orders({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const user = await requireUser("/meus-pedidos");
  const filter = FILTERS.find((f) => f.value === (sp.situacao ?? "")) ?? FILTERS[0];
  const page = Math.max(1, Number(sp.pagina) || 1);
  const where: Prisma.OrderWhereInput = { userId: user.id, ...(filter.statuses ? { status: { in: filter.statuses } } : {}) };
  const [total, orders] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({
      where,
      include: {
        event: { select: { title: true, startsAt: true, timezone: true, coverImageUrl: true } },
        items: { select: { quantity: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mt-6 space-y-5">
      <nav aria-label="Filtrar pedidos" className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {FILTERS.map((f) => (
          <Link
            key={f.value}
            href={href(f.value)}
            aria-current={f === filter ? "page" : undefined}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition",
              f === filter ? "bg-secondary text-secondary-foreground" : "bg-muted text-foreground hover:bg-border",
            )}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {total === 1 ? "1 pedido" : `${total} pedidos`}
      </p>

      {orders.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border p-10 text-center">
          <Receipt className="mx-auto size-10 text-secondary" aria-hidden />
          <p className="mt-3 font-semibold">{filter.value ? "Nenhum pedido com essa situação." : "Você ainda não fez nenhum pedido."}</p>
          <Link href="/eventos" className={buttonVariants({ variant: "secondary", className: "mt-4" })}>
            Explorar eventos
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => {
            const st = ORDER_STATUS[o.status];
            const count = o.items.reduce((s, i) => s + i.quantity, 0);
            return (
              <li key={o.id}>
                <Link
                  href={`/pedido/${o.id}`}
                  className="flex items-center gap-4 overflow-hidden rounded-2xl border border-border bg-card p-3 transition hover:border-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4"
                >
                  <div className="hidden size-20 shrink-0 overflow-hidden rounded-xl sm:block">
                    <EventCover src={o.event.coverImageUrl} alt="" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={st.tone}>{st.label}</Badge>
                      <span className="font-mono text-xs text-muted-foreground">{o.publicCode}</span>
                    </div>
                    <h2 className="mt-1 truncate font-display text-lg font-bold">{o.event.title}</h2>
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <CalendarDays className="size-3.5 shrink-0" aria-hidden /> {formatEventDateTime(o.event.startsAt, o.event.timezone)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Comprado em {formatDateShort(o.createdAt)} · {count === 1 ? "1 ingresso" : `${count} ingressos`}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-bold tabular-nums">{formatBRL(o.totalCents)}</p>
                    <ChevronRight className="ml-auto mt-1 size-5 text-muted-foreground" aria-hidden />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {pageCount > 1 && (
        <nav aria-label="Paginação" className="flex items-center justify-center gap-3 pt-2">
          {page > 1 && (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={href(filter.value, page - 1)}>
              Anterior
            </Link>
          )}
          <span className="text-sm text-muted-foreground">
            Página {page} de {pageCount}
          </span>
          {page < pageCount && (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={href(filter.value, page + 1)}>
              Próxima
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
