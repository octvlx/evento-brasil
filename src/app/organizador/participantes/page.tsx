import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Download } from "lucide-react";
import { Badge, Input, Select, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { PageTitle } from "@/components/site/panel-shell";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { listAttendeesPage, listTransferHistory, type AttendeeStatusFilter, type TransferHistoryRow } from "@/server/services/reports";
import { adminHref, Pager } from "@/features/admin/pager";
import { listOfflineDivergences, type OfflineDivergenceRow } from "@/server/services/checkin";
import { formatDateTimeShort } from "@/lib/datetime";
import { CHECKIN_RESULT, TICKET_KIND, TICKET_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Participantes", robots: { index: false } };

export default function AttendeesPage({ searchParams }: PageProps<"/organizador/participantes">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<Params>} />
    </Suspense>
  );
}

type Params = { evento?: string; q?: string; status?: string; pagina?: string; divergencias?: string };
const STATUS_FILTERS: AttendeeStatusFilter[] = ["VALID", "CHECKED_IN", "REVOKED"];
const PATH = "/organizador/participantes";

async function Content({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { evento } = sp;
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 100) : "";
  const status = STATUS_FILTERS.find((s) => s === sp.status);
  const { user, org, can } = await requireOrganizer("/organizador/participantes");
  if (!can("attendees:read")) redirect("/organizador");
  const events = await db.event.findMany({ where: { organizationId: org.id }, select: { id: true, title: true, timezone: true }, orderBy: { startsAt: "desc" } });
  const selected = events.find((e) => e.id === evento) ?? events[0];
  const list = selected ? await listAttendeesPage(db, user, selected.id, { page: Number(sp.pagina) || 1, q, status }) : null;
  const rows = list?.rows ?? [];
  const divergences = selected && can("checkin:history") ? await listOfflineDivergences(db, user, selected.id, { page: Number(sp.divergencias) || 1 }) : null;
  const withTransfers = rows.filter((r) => r.transferCount > 0).map((r) => r.id);
  const history = selected && withTransfers.length ? await listTransferHistory(db, user, selected.id, withTransfers) : [];
  // Filtros mantidos ao paginar (cada lista tem sua própria página).
  const keep = { evento: selected?.id, q: q || undefined, status, divergencias: sp.divergencias, pagina: sp.pagina };
  const historyByTicket = new Map<string, TransferHistoryRow[]>();
  for (const h of history) historyByTicket.set(h.ticketId, [...(historyByTicket.get(h.ticketId) ?? []), h]);
  return (
    <>
      <PageTitle
        title="Participantes"
        actions={
          selected && (
            <a href={`/api/organizador/eventos/${selected.id}/participantes`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Download aria-hidden /> Exportar CSV
            </a>
          )
        }
      />
      {events.length === 0 ? (
        <p className="text-muted-foreground">Nenhum evento.</p>
      ) : (
        <>
          <form className="mb-4 flex max-w-lg gap-2 [&>select]:min-w-0">
            <Select name="evento" defaultValue={selected?.id} aria-label="Evento">
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </Select>
            <button className={buttonVariants({ variant: "secondary" })}>Ver</button>
          </form>
          {divergences && divergences.total > 0 && (
            <OfflineDivergences list={divergences} timezone={selected!.timezone} pager={<Pager path={PATH} params={{ ...keep, divergencias: undefined }} param="divergencias" anchor="divergencias" page={divergences.page} pageCount={divergences.pageCount} total={divergences.total} />} />
          )}
          {list && (
            <p className="mb-3 text-sm text-muted-foreground">
              {list.totals.tickets} ingresso(s) · {list.totals.checkedIn} check-in(s) · {list.totals.transferred} transferido(s)
            </p>
          )}
          <form className="mb-3 flex flex-wrap items-end gap-2" role="search" aria-label="Buscar participantes">
            <input type="hidden" name="evento" value={selected?.id} />
            <Input name="q" defaultValue={q} placeholder="Nome, e-mail, código do ingresso ou do pedido" aria-label="Buscar por nome, e-mail ou código" className="min-w-0 basis-full sm:max-w-sm sm:flex-1 sm:basis-0" />
            <Select name="status" defaultValue={status ?? ""} aria-label="Situação" className="w-auto">
              <option value="">Todas as situações</option>
              {STATUS_FILTERS.map((st) => (
                <option key={st} value={st}>
                  {TICKET_STATUS[st].label}
                </option>
              ))}
            </Select>
            <button className={buttonVariants({ variant: "secondary" })}>Filtrar</button>
            {(q || status) && (
              <a href={adminHref(PATH, { evento: selected?.id })} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Limpar
              </a>
            )}
          </form>
          {list && (q || status) && (
            <p className="mb-2 text-sm" role="status">
              {list.matching === 0 ? "Nenhum participante encontrado com esses filtros." : `${list.matching} encontrado(s).`}
            </p>
          )}
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Código</th>
                  <th className="p-3">Titular atual</th>
                  <th className="p-3">Ingresso</th>
                  <th className="p-3">Pedido</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Check-in</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const s = TICKET_STATUS[t.status];
                  return (
                    <tr key={t.id} className="border-t border-border">
                      <td className="p-3 font-mono">{t.code}</td>
                      <td className="p-3">
                        <p>
                          {t.holderName}{" "}
                          {t.transferred && <Badge variant="warning">Transferido</Badge>}{" "}
                          {t.pendingTransfer && <Badge>Transferência pendente</Badge>}
                        </p>
                        <p className="text-xs text-muted-foreground">{t.holderEmail}</p>
                        {historyByTicket.has(t.id) && <TransferHistory items={historyByTicket.get(t.id)!} timezone={selected!.timezone} />}
                      </td>
                      <td className="p-3">
                        {t.ticketType.name} <span className="text-xs text-muted-foreground">({TICKET_KIND[t.ticketType.kind]})</span>
                      </td>
                      <td className="p-3 font-mono">{t.order.publicCode}</td>
                      <td className="p-3">
                        <Badge variant={s.tone === "success" ? "success" : s.tone === "danger" ? "danger" : "default"}>{s.label}</Badge>
                      </td>
                      <td className="p-3">{t.checkedInAt ? formatDateTimeShort(t.checkedInAt, selected!.timezone) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {list && <Pager path={PATH} params={{ ...keep, pagina: undefined }} page={list.page} pageCount={list.pageCount} total={list.matching} />}
        </>
      )}
    </>
  );
}

const TRANSFER_STATUS: Record<TransferHistoryRow["status"], string> = {
  PENDING: "Pendente",
  ACCEPTED: "Aceita",
  CANCELLED: "Cancelada",
  EXPIRED: "Expirada",
};

function TransferHistory({ items, timezone }: { items: TransferHistoryRow[]; timezone: string }) {
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-primary">Histórico de transferências ({items.length})</summary>
      <ol className="mt-1 space-y-1">
        {items.map((h) => (
          <li key={h.id}>
            {formatDateTimeShort(h.createdAt, timezone)}: {h.fromHolderName} ({h.fromHolderEmail}) → {h.toHolderName ? `${h.toHolderName} (${h.toEmail})` : h.toEmail}
            {" · "}
            {TRANSFER_STATUS[h.status]}
            {h.decidedAt && ` em ${formatDateTimeShort(h.decidedAt, timezone)}`}
            {h.initiatedBy === "ADMIN" && " · pela plataforma"}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Leituras sem internet em que o aparelho da portaria e o servidor discordaram. */
function OfflineDivergences({ list, timezone, pager }: { list: { rows: OfflineDivergenceRow[]; total: number; admittedButRejected: number }; timezone: string; pager: React.ReactNode }) {
  const items = list.rows;
  const admitted = list.admittedButRejected;
  const refused = list.total - admitted;
  return (
    <section id="divergencias" aria-labelledby="divergencias-titulo" className="mb-6 rounded-2xl border border-warning/40 bg-warning-soft p-4 text-sm">
      <h2 id="divergencias-titulo" className="font-bold">
        Divergências do check-in offline ({list.total})
      </h2>
      <p className="mt-1 text-muted-foreground">
        Leituras feitas sem internet em que o aparelho da portaria e o servidor discordaram.
        {admitted > 0 && ` ${admitted} liberada(s) na porta, mas recusada(s) pelo servidor: a pessoa entrou com um ingresso já usado ou cancelado.`}
        {refused > 0 && ` ${refused} recusada(s) na porta com ingresso válido: o ingresso continua sem entrada.`}
      </p>
      <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-background">
        <table className="w-full min-w-[640px]">
          <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-2">Leitura</th>
              <th className="p-2">Ingresso</th>
              <th className="p-2">Na porta</th>
              <th className="p-2">Servidor</th>
              <th className="p-2">Portaria</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id} className="border-t border-border align-top">
                <td className="p-2 tabular-nums">{formatDateTimeShort(d.scannedAt, timezone)}</td>
                <td className="p-2">
                  {d.ticket ? (
                    <>
                      <p>{d.ticket.holderName ?? "—"}</p>
                      <p className="font-mono text-xs text-muted-foreground">{d.ticket.code}</p>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="p-2">
                  <Badge variant={d.localResult === "ADMITTED" ? "success" : "danger"}>{d.localResult ? CHECKIN_RESULT[d.localResult] : "—"}</Badge>
                </td>
                <td className="p-2">
                  {d.divergence === "REFUSED_BUT_VALID" ? (
                    <Badge variant="warning">Ingresso válido</Badge>
                  ) : (
                    <Badge variant="danger">{CHECKIN_RESULT[d.result]}</Badge>
                  )}
                  {d.divergence === "ADMITTED_BUT_REJECTED" && d.result === "DUPLICATE" && d.ticket?.checkedInAt && (
                    <p className="mt-1 text-xs text-muted-foreground">Entrada já registrada em {formatDateTimeShort(d.ticket.checkedInAt, timezone)}</p>
                  )}
                  {d.divergence === "REFUSED_BUT_VALID" && d.ticket?.status === "CHECKED_IN" && d.ticket.checkedInAt && (
                    <p className="mt-1 text-xs text-muted-foreground">Entrou depois, em {formatDateTimeShort(d.ticket.checkedInAt, timezone)}</p>
                  )}
                </td>
                <td className="p-2">{d.scannedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager}
    </section>
  );
}
