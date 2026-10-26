import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { formatDateTimeShort } from "@/lib/datetime";

export const metadata: Metadata = { title: "Auditoria — admin", robots: { index: false } };

export default function AdminAudit({ searchParams }: PageProps<"/admin/auditoria">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<{ acao?: string }>} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: Promise<{ acao?: string }> }) {
  await requireAdmin();
  const { acao } = await searchParams;
  const logs = await db.auditLog.findMany({
    where: acao ? { action: { startsWith: acao } } : {},
    include: { actor: { select: { email: true } }, organization: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return (
    <>
      <PageTitle title="Auditoria" subtitle="Últimos 200 registros" />
      <form className="mb-4 max-w-sm">
        <input name="acao" defaultValue={acao} placeholder="Filtrar por ação (ex.: refund, event.)" aria-label="Filtrar por ação" className="h-10 w-full rounded-xl border border-input bg-card px-3 text-sm" />
      </form>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[760px] text-xs">
          <thead className="bg-muted text-left uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Quando</th>
              <th className="p-3">Ação</th>
              <th className="p-3">Ator</th>
              <th className="p-3">Organização</th>
              <th className="p-3">Entidade</th>
              <th className="p-3">Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap p-3">{formatDateTimeShort(l.createdAt)}</td>
                <td className="p-3 font-mono">{l.action}</td>
                <td className="p-3">{l.actor?.email ?? "sistema"}</td>
                <td className="p-3">{l.organization?.name ?? "—"}</td>
                <td className="p-3 font-mono">
                  {l.entityType}:{l.entityId.slice(-8)}
                </td>
                <td className="max-w-xs truncate p-3 font-mono text-muted-foreground">{l.metadata ? JSON.stringify(l.metadata) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
