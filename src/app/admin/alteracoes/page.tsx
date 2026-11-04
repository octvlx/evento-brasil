import type { Metadata } from "next";
import { Suspense } from "react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { Pager } from "@/features/admin/pager";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { listOpenChangeWindows, parsePage } from "@/server/services/admin-oversight";
import { formatDateTimeShort } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { EVENT_STATUS, REFUND_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Alterações de evento — admin", robots: { index: false } };

type Search = { pagina?: string };

export default function AdminEventChanges({ searchParams }: PageProps<"/admin/alteracoes">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<Search>} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin("events:moderate");
  const sp = await searchParams;
  const result = await listOpenChangeWindows(db, admin, { page: parsePage(sp.pagina) });
  return (
    <>
      <PageTitle
        title="Alterações relevantes de evento"
        subtitle="Janelas de reembolso integral ainda abertas (inclui prorrogações). Valem para pedidos pagos antes da alteração."
      />
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Evento</th>
              <th className="p-3">Alteração</th>
              <th className="p-3">Reembolso até</th>
              <th className="p-3 text-right">Reembolsos pela janela</th>
              <th className="p-3 text-right">Pedidos pagos antes, ainda ativos</th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-muted-foreground">
                  Nenhuma janela aberta.
                </td>
              </tr>
            )}
            {result.items.map((c) => (
              <tr key={c.id} className="border-t border-border align-top">
                <td className="p-3">
                  {c.event.title}
                  <span className="block text-xs text-muted-foreground">
                    {c.organization.name} · {formatDateTimeShort(c.event.startsAt, c.event.timezone)} · {EVENT_STATUS[c.event.status]?.label ?? c.event.status}
                  </span>
                </td>
                <td className="max-w-xs p-3">
                  <span className="font-mono text-xs">{c.changedFields.join(", ") || "—"}</span>
                  <span className="block text-xs text-muted-foreground">
                    {formatDateTimeShort(c.createdAt)} · {c.reason}
                  </span>
                </td>
                <td className="whitespace-nowrap p-3">
                  {formatDateTimeShort(c.effectiveRefundUntil)}
                  {c.extended && (
                    <Badge variant="warning" className="ml-2">
                      prorrogada
                    </Badge>
                  )}
                </td>
                <td className="p-3 text-right">
                  <span className="tabular-nums">{c.refundsTotal}</span>
                  {c.refundsTotal > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {Object.entries(c.refundsByStatus)
                        .map(([s, n]) => `${n} ${REFUND_STATUS[s]?.toLowerCase() ?? s}`)
                        .join(" · ")}
                      {c.refundedCents > 0 && ` · ${formatBRL(c.refundedCents)} devolvidos`}
                    </span>
                  )}
                </td>
                <td className="p-3 text-right tabular-nums">{c.paidOrdersStillEligible}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager path="/admin/alteracoes" params={{}} page={result.page} pageCount={result.pageCount} total={result.total} />
    </>
  );
}
