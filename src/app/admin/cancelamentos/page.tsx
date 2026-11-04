import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { adminHref, Pager } from "@/features/admin/pager";
import { CANCELLATION_STATUS } from "@/features/admin/labels";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { listCancellationQueue, parseCancellationStatus, parsePage } from "@/server/services/admin-oversight";
import { formatDateTimeShort } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { ORDER_STATUS, REFUND_STATUS } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Pedidos de cancelamento — admin", robots: { index: false } };

type Search = { status?: string; vencidos?: string; pagina?: string };

export default function AdminCancellations({ searchParams }: PageProps<"/admin/cancelamentos">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<Search>} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin("cancellations:decide");
  const sp = await searchParams;
  const overdueOnly = sp.vencidos === "1";
  const queue = await listCancellationQueue(db, admin, { status: parseCancellationStatus(sp.status), overdueOnly, page: parsePage(sp.pagina) });
  const filters: [string, Record<string, string>][] = [
    ["Abertos", { status: "OPEN" }],
    [`Prazo vencido (${queue.overdueCount})`, { vencidos: "1" }],
    ["Aprovados", { status: "APPROVED" }],
    ["Recusados", { status: "REJECTED" }],
    ["Desistências", { status: "WITHDRAWN" }],
  ];
  const isActive = (f: Record<string, string>) => (f.vencidos ? overdueOnly : !overdueOnly && f.status === queue.status);
  return (
    <>
      <PageTitle title="Pedidos de cancelamento" subtitle="Abertos primeiro pelo prazo de resposta; a decisão segue o fluxo normal de reembolso." />
      <nav aria-label="Filtrar por status" className="mb-4 flex flex-wrap gap-2 text-sm">
        {filters.map(([label, f]) => (
          <Link
            key={label}
            href={adminHref("/admin/cancelamentos", f)}
            aria-current={isActive(f) ? "page" : undefined}
            className={cn("rounded-full border px-3 py-1", isActive(f) ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted")}
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Protocolo</th>
              <th className="p-3">Pedido / evento</th>
              <th className="p-3">Comprador</th>
              <th className="p-3">Aberto em</th>
              <th className="p-3">{queue.status === "OPEN" ? "Responder até" : "Decidido em"}</th>
              <th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {queue.items.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-muted-foreground">
                  Nenhum pedido nesta fila.
                </td>
              </tr>
            )}
            {queue.items.map((r) => (
              <tr key={r.id} className={cn("border-t border-border", r.overdue && "bg-destructive/5")} data-overdue={r.overdue || undefined}>
                <td className="p-3">
                  <Link href={`/admin/cancelamentos/${r.id}`} className="font-mono font-semibold text-secondary underline-offset-4 hover:underline">
                    {r.protocol}
                  </Link>
                </td>
                <td className="p-3">
                  <span className="font-mono">{r.order.publicCode}</span> · {formatBRL(r.order.totalCents)} · {ORDER_STATUS[r.order.status]?.label ?? r.order.status}
                  <span className="block text-xs text-muted-foreground">{r.event.title}</span>
                </td>
                <td className="p-3">{r.requestedBy.email}</td>
                <td className="whitespace-nowrap p-3">{formatDateTimeShort(r.createdAt)}</td>
                <td className="whitespace-nowrap p-3">
                  {queue.status === "OPEN" ? (r.respondBy ? formatDateTimeShort(r.respondBy) : "—") : r.decidedAt ? formatDateTimeShort(r.decidedAt) : "—"}
                  {r.overdue && (
                    <Badge variant="danger" className="ml-2">
                      vencido
                    </Badge>
                  )}
                </td>
                <td className="p-3">
                  {CANCELLATION_STATUS[r.status]}
                  {r.refunds[0] && <span className="block text-xs text-muted-foreground">Reembolso: {REFUND_STATUS[r.refunds[0].status]}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager path="/admin/cancelamentos" params={{ status: overdueOnly ? undefined : queue.status, vencidos: overdueOnly ? "1" : undefined }} page={queue.page} pageCount={queue.pageCount} total={queue.total} />
    </>
  );
}
