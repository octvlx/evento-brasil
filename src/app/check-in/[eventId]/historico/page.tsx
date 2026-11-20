import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft, Download } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Label, Select, Skeleton } from "@/components/ui/primitives";
import { adminHref, Pager } from "@/features/admin/pager";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { AppError } from "@/server/errors";
import { CHECKIN_RESULTS, checkinHistoryReport, checkinHistoryParams, parseCheckinHistoryFilters } from "@/server/services/checkin";
import { formatDateTimeShort } from "@/lib/datetime";
import { CHECKIN_RESULT } from "@/lib/labels";

export const metadata: Metadata = { title: "Histórico do check-in", robots: { index: false } };

type Search = { resultado?: string; origem?: string; pagina?: string };

export default function CheckinHistoryPage({ params, searchParams }: PageProps<"/check-in/[eventId]/historico">) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <Suspense fallback={<Skeleton className="h-[640px]" />}>
        <Content params={params} searchParams={searchParams as Promise<Search>} />
      </Suspense>
    </div>
  );
}

async function Content({ params, searchParams }: { params: Promise<{ eventId: string }>; searchParams: Promise<Search> }) {
  const { eventId } = await params;
  const sp = await searchParams;
  const user = await requireUser(`/check-in/${eventId}/historico`);
  const filters = parseCheckinHistoryFilters(sp);
  let report;
  try {
    report = await checkinHistoryReport(db, user, eventId, filters, { page: Number(sp.pagina) || 1 });
  } catch (err) {
    if (err instanceof AppError) notFound();
    throw err;
  }
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { title: true } });
  const params_ = checkinHistoryParams(filters);
  const maxHour = Math.max(1, ...report.perHour.map((h) => h.admitted));
  const totalScans = Object.values(report.counts).reduce((s, n) => s + n, 0);
  return (
    <>
      <Link href={`/check-in/${eventId}`} className={buttonVariants({ variant: "ghost", className: "mb-4" })}>
        <ArrowLeft aria-hidden /> Voltar ao leitor
      </Link>
      <h1 className="font-display text-2xl font-extrabold leading-tight">Histórico do check-in</h1>
      <p className="mb-4 text-sm text-muted-foreground">{event.title} · horários no fuso do evento</p>

      <section aria-label="Leituras por resultado" className="mb-6">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CHECKIN_RESULTS.map((r) => (
            <div key={r} className="rounded-2xl border border-border bg-card p-3" data-testid={`count-${r}`}>
              <dt className="text-xs text-muted-foreground">{CHECKIN_RESULT[r]}</dt>
              <dd className="font-display text-2xl font-extrabold tabular-nums">{report.counts[r]}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">{totalScans} leituras no total.</p>
      </section>

      <section aria-labelledby="por-hora" className="mb-6">
        <h2 id="por-hora" className="mb-2 text-sm font-bold">
          Entradas por hora
        </h2>
        {report.perHour.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma entrada liberada ainda.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th>Hora</th>
                <th>Entradas</th>
              </tr>
            </thead>
            <tbody>
              {report.perHour.map((h) => (
                <tr key={h.hour}>
                  <td className="w-28 py-1 pr-2 tabular-nums text-muted-foreground">
                    {h.hour.slice(8, 10)}/{h.hour.slice(5, 7)} {h.hour.slice(11)}
                  </td>
                  <td className="py-1">
                    <span className="flex items-center gap-2">
                      <span className="h-3 rounded-full bg-secondary" style={{ width: `${Math.max(2, (h.admitted / maxHour) * 100)}%` }} aria-hidden />
                      <span className="tabular-nums">{h.admitted}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <form method="get" action={`/check-in/${eventId}/historico`} aria-label="Filtrar leituras" className="mb-3 grid gap-3 rounded-2xl border border-border bg-card p-3 sm:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-1">
          <Label htmlFor="hist-resultado">Resultado</Label>
          <Select id="hist-resultado" name="resultado" defaultValue={filters.result ?? ""}>
            <option value="">Todos</option>
            {CHECKIN_RESULTS.map((r) => (
              <option key={r} value={r}>
                {CHECKIN_RESULT[r]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="hist-origem">Origem</Label>
          <Select id="hist-origem" name="origem" defaultValue={params_.origem ?? ""}>
            <option value="">Online e offline</option>
            <option value="online">Online</option>
            <option value="offline">Offline (sincronizadas)</option>
          </Select>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button type="submit" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Filtrar
          </button>
          <a href={adminHref(`/check-in/${eventId}/historico/csv`, params_)} className={buttonVariants({ variant: "outline", size: "sm" })} download>
            <Download aria-hidden /> CSV
          </a>
        </div>
      </form>

      <ul className="divide-y divide-border rounded-2xl border border-border text-sm" data-testid="history-rows">
        {report.rows.length === 0 && <li className="p-3 text-muted-foreground">Nenhuma leitura com esses filtros.</li>}
        {report.rows.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
            <span className="tabular-nums text-muted-foreground">{formatDateTimeShort(h.scannedAt, report.timezone)}</span>
            {h.offline && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">offline</span>}
            <span className="min-w-0 flex-1 truncate">
              {h.ticket?.holderName ?? "—"}
              {h.ticket && <span className="text-muted-foreground"> · {h.ticket.code}</span>}
            </span>
            <span className="text-xs text-muted-foreground">{h.scannedBy.name}</span>
            <span className={h.result === "ADMITTED" ? "font-semibold text-success" : "font-semibold text-destructive"}>{CHECKIN_RESULT[h.result]}</span>
          </li>
        ))}
      </ul>
      <Pager path={`/check-in/${eventId}/historico`} params={params_} page={report.page} pageCount={report.pageCount} total={report.total} />
    </>
  );
}
