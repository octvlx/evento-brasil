import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Input, Label, Select, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { adminHref, Pager } from "@/features/admin/pager";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import {
  AUDIT_EXPORT_LIMIT,
  AUDIT_PRESETS,
  auditEntityTypes,
  auditFilterParams,
  listAuditLogs,
  parseAuditFilters,
  parsePage,
} from "@/server/services/admin-oversight";
import { formatDateTimeShort } from "@/lib/datetime";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Auditoria — admin", robots: { index: false } };

type Search = { acao?: string; grupo?: string; ator?: string; entidade?: string; id?: string; de?: string; ate?: string; pagina?: string };

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
  const filters = parseAuditFilters(sp);
  const { preset } = filters;
  const params = auditFilterParams(filters);
  const [logs, entityTypes] = await Promise.all([listAuditLogs(db, admin, { ...filters, page: parsePage(sp.pagina) }), auditEntityTypes(db, admin)]);
  const filtered = Object.values(params).some(Boolean);
  const chip = (active: boolean) => cn("rounded-full border px-3 py-1", active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted");
  return (
    <>
      <PageTitle title="Auditoria" subtitle="Registros mais recentes primeiro (somente inserção)." />
      <nav aria-label="Filtrar por grupo de ações" className="mb-3 flex flex-wrap gap-2 text-sm">
        <Link href={adminHref("/admin/auditoria", { ...params, grupo: undefined })} aria-current={!preset ? "page" : undefined} className={chip(!preset)}>
          Todas
        </Link>
        {Object.entries(AUDIT_PRESETS).map(([key, p]) => (
          <Link key={key} href={adminHref("/admin/auditoria", { ...params, grupo: key })} aria-current={preset === key ? "page" : undefined} className={chip(preset === key)}>
            {p.label}
          </Link>
        ))}
      </nav>
      <form method="get" action="/admin/auditoria" aria-label="Filtrar registros de auditoria" className="mb-3 grid gap-3 rounded-2xl border border-border bg-card p-3 shadow-card sm:grid-cols-2 lg:grid-cols-4">
        {preset && <input type="hidden" name="grupo" value={preset} />}
        <div className="space-y-1">
          <Label htmlFor="audit-acao">Ação (começa com)</Label>
          <Input id="audit-acao" name="acao" defaultValue={filters.action} placeholder="ex.: refund, event." maxLength={100} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-ator">Ator</Label>
          <Input id="audit-ator" name="ator" defaultValue={filters.actor} placeholder="Parte do e-mail ou “sistema”" maxLength={254} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-entidade">Entidade</Label>
          <Select id="audit-entidade" name="entidade" defaultValue={filters.entityType ?? ""}>
            <option value="">Todas</option>
            {entityTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-id">ID da entidade</Label>
          <Input id="audit-id" name="id" defaultValue={filters.entityId} placeholder="Completo ou os últimos caracteres" maxLength={60} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-de">De</Label>
          <Input id="audit-de" name="de" type="date" defaultValue={filters.period?.de} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="audit-ate">Até</Label>
          <Input id="audit-ate" name="ate" type="date" defaultValue={filters.period?.ate} />
        </div>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
          <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Filtrar
          </button>
          {filtered && (
            <Link href="/admin/auditoria" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Limpar
            </Link>
          )}
          <a href={adminHref("/admin/auditoria/csv", params)} className={buttonVariants({ variant: "outline", size: "sm" })} download>
            Exportar CSV
          </a>
        </div>
      </form>
      <p className="mb-3 text-xs text-muted-foreground">
        O CSV leva os filtros acima (até {AUDIT_EXPORT_LIMIT.toLocaleString("pt-BR")} registros) e a exportação fica registrada na auditoria. Datas no horário de São Paulo.
      </p>
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
                <td className="p-3 font-mono" title={`${l.entityType}:${l.entityId}`}>
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
      <Pager path="/admin/auditoria" params={params} page={logs.page} pageCount={logs.pageCount} total={logs.total} />
    </>
  );
}
