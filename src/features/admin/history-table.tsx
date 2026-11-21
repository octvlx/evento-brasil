import Link from "next/link";
import { Pager, adminHref } from "@/features/admin/pager";
import { formatDateTimeShort } from "@/lib/datetime";

type HistoryItem = {
  id: string;
  createdAt: Date;
  action: string;
  actor: { email: string } | null;
  metadata: unknown;
};

/**
 * Histórico de uma entidade (página de detalhe do admin): quando, ação, quem e detalhes.
 * `auditHref` (só para quem tem audit:read) leva à auditoria completa já filtrada.
 */
export function HistoryTable({
  history,
  path,
  auditHref,
}: {
  history: { items: HistoryItem[]; total: number; page: number; pageCount: number };
  path: string;
  auditHref?: string;
}) {
  return (
    <section aria-labelledby="history-title" id="historico" className="scroll-mt-24">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="history-title" className="text-sm font-bold">
          Histórico ({history.total})
        </h2>
        {auditHref && (
          <Link href={auditHref} className="text-xs font-semibold text-secondary hover:underline">
            Abrir na auditoria
          </Link>
        )}
      </div>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[640px] text-xs" data-testid="history-table">
          <thead className="bg-muted text-left uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Quando</th>
              <th className="p-3">Ação</th>
              <th className="p-3">Quem</th>
              <th className="p-3">Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {history.items.length === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-muted-foreground">
                  Nenhum registro.
                </td>
              </tr>
            )}
            {history.items.map((l) => (
              <tr key={l.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap p-3">{formatDateTimeShort(l.createdAt)}</td>
                <td className="p-3 font-mono">{l.action}</td>
                <td className="p-3">{l.actor?.email ?? "sistema"}</td>
                <td className="max-w-md break-words p-3 font-mono text-muted-foreground">{l.metadata ? JSON.stringify(l.metadata) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager path={path} params={{}} page={history.page} pageCount={history.pageCount} total={history.total} param="historico" anchor="historico" />
    </section>
  );
}

export const auditLinkFor = (entityType: string, entityId: string) => adminHref("/admin/auditoria", { entidade: entityType, id: entityId });
