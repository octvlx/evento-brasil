import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { adminHref, Pager } from "@/features/admin/pager";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { AUDIT_PRESETS, listAuditLogs, parseAuditPreset, parsePage } from "@/server/services/admin-oversight";
import { formatDateTimeShort } from "@/lib/datetime";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Auditoria — admin", robots: { index: false } };

type Search = { acao?: string; grupo?: string; pagina?: string };

export default function AdminAudit({ searchParams }: PageProps<"/admin/auditoria">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<Search>} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin("audit:read");
  const sp = await searchParams;
  const preset = parseAuditPreset(sp.grupo);
  const acao = sp.acao?.trim() || undefined;
  const logs = await listAuditLogs(db, admin, { preset, action: acao, page: parsePage(sp.pagina) });
  const chip = (active: boolean) => cn("rounded-full border px-3 py-1", active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted");
  return (
    <>
      <PageTitle title="Auditoria" subtitle="Registros mais recentes primeiro (somente inserção)." />
      <nav aria-label="Filtrar por grupo de ações" className="mb-3 flex flex-wrap gap-2 text-sm">
        <Link href={adminHref("/admin/auditoria", { acao })} aria-current={!preset ? "page" : undefined} className={chip(!preset)}>
          Todas
        </Link>
        {Object.entries(AUDIT_PRESETS).map(([key, p]) => (
          <Link key={key} href={adminHref("/admin/auditoria", { grupo: key, acao })} aria-current={preset === key ? "page" : undefined} className={chip(preset === key)}>
            {p.label}
          </Link>
        ))}
      </nav>
      <form className="mb-4 max-w-sm">
        {preset && <input type="hidden" name="grupo" value={preset} />}
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
            {logs.items.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-muted-foreground">
                  Nenhum registro.
                </td>
              </tr>
            )}
            {logs.items.map((l) => (
              <tr key={l.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap p-3">{formatDateTimeShort(l.createdAt)}</td>
                <td className="p-3 font-mono">{l.action}</td>
                <td className="p-3">{l.actor?.email ?? "sistema"}</td>
                <td className="p-3">{l.organization?.name ?? "—"}</td>
                <td className="p-3 font-mono">
                  {l.entityType}:{l.entityId.slice(-8)}
                </td>
                <td className="max-w-xs truncate p-3 font-mono text-muted-foreground" title={l.metadata ? JSON.stringify(l.metadata) : undefined}>
                  {l.metadata ? JSON.stringify(l.metadata) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager path="/admin/auditoria" params={{ grupo: preset, acao }} page={logs.page} pageCount={logs.pageCount} total={logs.total} />
    </>
  );
}
