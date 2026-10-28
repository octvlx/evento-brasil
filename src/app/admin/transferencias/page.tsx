import type { Metadata } from "next";
import { Suspense } from "react";
import { Badge, Card, Input, Select, Skeleton } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { Pager } from "@/features/admin/pager";
import { TRANSFER_INITIATOR, TRANSFER_STATUS } from "@/features/admin/labels";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { parsePage, parseTransferStatus, searchTransfers, transferPatternReport } from "@/server/services/admin-oversight";
import { formatDateTimeShort } from "@/lib/datetime";

export const metadata: Metadata = { title: "Transferências — admin", robots: { index: false } };

type Search = { q?: string; status?: string; pagina?: string };

export default function AdminTransfers({ searchParams }: PageProps<"/admin/transferencias">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<Search>} />
    </Suspense>
  );
}

function PatternList({ title, rows, unit }: { title: string; rows: { key: string; count: number; lastAt: Date | null }[]; unit: string }) {
  return (
    <div>
      <h3 className="text-xs font-bold uppercase text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">Nada acima do limiar.</p>
      ) : (
        <ul className="mt-1 text-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap gap-x-2">
              <span className="font-mono">{r.key}</span>
              <Badge variant="warning">
                {r.count} {unit}
              </Badge>
              {r.lastAt && <span className="text-xs text-muted-foreground">última {formatDateTimeShort(r.lastAt)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function Content({ searchParams }: { searchParams: Promise<Search> }) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const status = parseTransferStatus(sp.status);
  const [result, report] = await Promise.all([searchTransfers(db, admin, { q: sp.q, status, page: parsePage(sp.pagina) }), transferPatternReport(db, admin)]);
  return (
    <>
      <PageTitle title="Transferências de ingressos" subtitle="Histórico somente leitura. Os sinais abaixo são para revisão manual; nada é bloqueado automaticamente." />

      <Card className="mb-6 p-4">
        <h2 className="text-sm font-bold">
          Padrões a revisar (últimas {report.windowHours}h, a partir de {report.minCount} transferências)
        </h2>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <PatternList title="Mesmo titular enviando" rows={report.senders} unit="envios" />
          <PatternList title="Mesmo e-mail recebendo" rows={report.recipients} unit="recebimentos" />
          <PatternList title="Mesmo ingresso" rows={report.tickets} unit="transferências" />
        </div>
      </Card>

      <form className="mb-4 flex flex-wrap items-end gap-2" role="search">
        <Input name="q" defaultValue={result.q} placeholder="Código do ingresso, e-mail ou evento" aria-label="Buscar transferências" className="max-w-sm" />
        <Select name="status" defaultValue={status ?? ""} aria-label="Status" className="w-auto">
          <option value="">Todos os status</option>
          {Object.entries(TRANSFER_STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="outline">
          Buscar
        </Button>
      </form>

      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Quando</th>
              <th className="p-3">Ingresso / evento</th>
              <th className="p-3">De</th>
              <th className="p-3">Para</th>
              <th className="p-3">Status</th>
              <th className="p-3">Origem</th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-muted-foreground">
                  Nenhuma transferência encontrada.
                </td>
              </tr>
            )}
            {result.items.map((t) => (
              <tr key={t.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap p-3">{formatDateTimeShort(t.createdAt)}</td>
                <td className="p-3">
                  <span className="font-mono">{t.ticket.code}</span>
                  <span className="block text-xs text-muted-foreground">{t.event.title}</span>
                </td>
                <td className="p-3">
                  {t.fromHolderName}
                  <span className="block text-xs text-muted-foreground">{t.fromHolderEmail}</span>
                </td>
                <td className="p-3">
                  {t.toHolderName ?? "—"}
                  <span className="block text-xs text-muted-foreground">{t.toEmail}</span>
                </td>
                <td className="p-3">
                  {TRANSFER_STATUS[t.status]}
                  {t.decidedAt && <span className="block text-xs text-muted-foreground">{formatDateTimeShort(t.decidedAt)}</span>}
                  {t.decisionReason && <span className="block text-xs text-muted-foreground">{t.decisionReason}</span>}
                </td>
                <td className="p-3">
                  {TRANSFER_INITIATOR[t.initiatedBy]}
                  {t.reason && <span className="block max-w-xs text-xs text-muted-foreground">{t.reason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager path="/admin/transferencias" params={{ q: result.q || undefined, status }} page={result.page} pageCount={result.pageCount} total={result.total} />
    </>
  );
}
