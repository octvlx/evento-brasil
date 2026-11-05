import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ExternalLink } from "lucide-react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { AdminActionButton } from "@/features/admin/controls";
import { featureExternalEventAction, reviewExternalEventAction, runExternalImportAction, setExternalSourceStatusAction } from "@/features/admin/actions";
import { ImportExternalByUrlForm } from "@/features/admin/external-controls";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { formatDateShort, formatEventDateTime } from "@/lib/datetime";
import { ADMIN_RUN_MAX_EVENTS, adminListExternalEvents, adminListExternalSources, adminListImportRuns } from "@/server/services/external-events";
import type { ExternalEventReview } from "@/generated/prisma/client";

export const metadata: Metadata = { title: "Eventos externos — admin", robots: { index: false } };

const SOURCE_STATUS = {
  ACTIVE: { label: "Ativa", variant: "success" },
  PAUSED: { label: "Pausada", variant: "default" },
  NEEDS_AUTHORIZATION: { label: "Precisa de autorização", variant: "warning" },
} as const;
const RUN_STATUS = {
  RUNNING: { label: "Em andamento", variant: "default" },
  SUCCEEDED: { label: "Concluída", variant: "success" },
  PARTIAL: { label: "Parcial", variant: "warning" },
  FAILED: { label: "Falhou", variant: "danger" },
} as const;
const SOURCE_EVENT = { ACTIVE: null, CANCELLED: "Cancelado na fonte", MISSING: "Não visto na última coleta" } as const;
const TABS: [ExternalEventReview, string][] = [
  ["PENDING_REVIEW", "Em revisão"],
  ["PUBLISHED", "Publicados"],
  ["HIDDEN", "Ocultos"],
];

export default function AdminExternalEvents({ searchParams }: PageProps<"/admin/eventos-externos">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: PageProps<"/admin/eventos-externos">["searchParams"] }) {
  const admin = await requireAdmin("events:moderate");
  const { aba } = await searchParams;
  const tab = (TABS.find(([k]) => k === aba)?.[0] ?? "PENDING_REVIEW") as ExternalEventReview;
  const [sources, runs, events] = await Promise.all([adminListExternalSources(db, admin), adminListImportRuns(db, admin), adminListExternalEvents(db, admin, tab)]);

  return (
    <>
      <PageTitle
        title="Eventos externos"
        subtitle="Eventos de outras plataformas: só dados públicos e factuais, revisados antes de publicar. A compra acontece no site original."
      />

      <section aria-labelledby="fontes" className="mb-8">
        <h2 id="fontes" className="mb-3 font-display text-lg font-bold">
          Fontes
        </h2>
        <ul className="grid gap-3 lg:grid-cols-3">
          {sources.map((s) => {
            const st = SOURCE_STATUS[s.status];
            return (
              <li key={s.id} className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-card">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-bold">{s.name}</p>
                  <Badge variant={st.variant}>{st.label}</Badge>
                </div>
                <a href={s.homeUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-xs text-secondary hover:underline">
                  {s.homeUrl} <ExternalLink className="size-3" aria-hidden />
                </a>
                {s.notes && <p className="text-xs text-muted-foreground">{s.notes}</p>}
                <p className="text-xs text-muted-foreground">
                  {s._count.events} eventos · última coleta: {s.lastRunAt ? formatDateShort(s.lastRunAt) : "nunca"}
                </p>
                {s.status !== "NEEDS_AUTHORIZATION" && s.hasAdapter && (
                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    {s.status === "ACTIVE" ? (
                      <>
                        <AdminActionButton
                          label="Importar agora"
                          variant="secondary"
                          confirm={`Busca até ${ADMIN_RUN_MAX_EVENTS} eventos na fonte, com pausa entre as páginas. Eventos novos entram em revisão.`}
                          action={runExternalImportAction.bind(null, s.id, ADMIN_RUN_MAX_EVENTS)}
                        />
                        <AdminActionButton label="Pausar" action={setExternalSourceStatusAction.bind(null, s.id, "PAUSED")} />
                      </>
                    ) : (
                      <AdminActionButton
                        label="Ativar"
                        confirm="Ativa a coleta automática limitada (a cada 6 horas) e a importação manual."
                        action={setExternalSourceStatusAction.bind(null, s.id, "ACTIVE")}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="por-link" className="mb-8 rounded-2xl border border-border bg-card p-4 shadow-card">
        <h2 id="por-link" className="mb-1 font-display text-lg font-bold">
          Cadastrar por link
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">Cole o link de um evento numa fonte autorizada. Ele entra em revisão; na edição você define a capa, publica e destaca.</p>
        <ImportExternalByUrlForm />
      </section>

      <section aria-labelledby="execucoes" className="mb-8">
        <h2 id="execucoes" className="mb-3 font-display text-lg font-bold">
          Últimas importações
        </h2>
        {runs.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Nenhuma importação ainda.</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
            {runs.map((r) => {
              const st = RUN_STATUS[r.status];
              const errors = Array.isArray(r.errors) ? (r.errors as { url?: string; error?: string }[]) : [];
              return (
                <li key={r.id} className="p-4 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.source.name}</span> <Badge variant={st.variant}>{st.label}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatEventDateTime(r.startedAt, "America/Sao_Paulo")} · {r.trigger === "CRON" ? "automática" : "manual"}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {r.pagesFetched} páginas · {r.eventsSeen} eventos lidos · {r.created} novos · {r.updated} atualizados · {r.unchanged} sem mudança · {r.failed} com erro
                  </p>
                  {errors.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-semibold text-destructive">Ver erros ({errors.length})</summary>
                      <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                        {errors.map((e, i) => (
                          <li key={i} className="break-all">
                            {e.url} — {e.error}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="revisao">
        <h2 id="revisao" className="mb-3 font-display text-lg font-bold">
          Eventos
        </h2>
        <nav aria-label="Situação dos eventos externos" className="mb-3 flex flex-wrap gap-2 text-sm">
          {TABS.map(([k, label]) => (
            <Link
              key={k}
              href={`/admin/eventos-externos?aba=${k}`}
              aria-current={k === tab ? "page" : undefined}
              className={k === tab ? "rounded-full bg-night px-3 py-1 font-semibold text-white" : "rounded-full border border-border px-3 py-1 hover:bg-muted"}
            >
              {label}
            </Link>
          ))}
        </nav>
        {events.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Nenhum evento nesta lista.</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="font-semibold">
                    <Link href={`/admin/eventos-externos/${e.id}`} className="hover:underline">
                      {e.title}
                    </Link>{" "}
                    <Badge>{e.source.name}</Badge> {e.isFeatured && <Badge variant="success">Destaque</Badge>} {!e.coverImageUrl && <Badge>Sem capa</Badge>} {SOURCE_EVENT[e.sourceStatus] && <Badge variant="warning">{SOURCE_EVENT[e.sourceStatus]}</Badge>}
                    {e.possibleDuplicateOf && (
                      <Badge variant="danger" className="ml-1">
                        Possível duplicado: {e.possibleDuplicateOf}
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {e.hasTime ? formatEventDateTime(e.startsAt, e.timezone) : `${formatDateShort(e.startsAt, e.timezone)} (horário não informado)`} ·{" "}
                    {[e.venueName, e.cityName && `${e.cityName} – ${e.state ?? "?"}`].filter(Boolean).join(" · ") || "Local não informado"} ·{" "}
                    {e.priceStatus === "FREE" ? "Gratuito" : e.priceStatus === "PAID" ? "Pago" : "Preço não informado"} · {e.viewCount} visualizações · {e.outboundClicks} cliques de saída
                  </p>
                  <p className="mt-1 flex flex-wrap gap-3 text-xs">
                    <Link href={`/admin/eventos-externos/${e.id}`} className="text-secondary hover:underline">
                      Editar capa e destaque
                    </Link>
                    {e.review === "PUBLISHED" && (
                      <Link href={`/eventos-externos/${e.slug}`} className="text-secondary hover:underline">
                        Página pública
                      </Link>
                    )}
                    <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-secondary hover:underline">
                      Conferir página original <ExternalLink className="size-3" aria-hidden />
                    </a>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {e.review !== "PUBLISHED" && <AdminActionButton label="Publicar" variant="secondary" action={reviewExternalEventAction.bind(null, e.id, "PUBLISHED")} />}
                  {e.review !== "HIDDEN" && <AdminActionButton label="Ocultar" action={reviewExternalEventAction.bind(null, e.id, "HIDDEN")} />}
                  {e.review !== "PENDING_REVIEW" && <AdminActionButton label="Voltar para revisão" variant="ghost" action={reviewExternalEventAction.bind(null, e.id, "PENDING_REVIEW")} />}
                  {e.review === "PUBLISHED" && (
                    <AdminActionButton label={e.isFeatured ? "Remover destaque" : "Destacar"} variant="ghost" action={featureExternalEventAction.bind(null, e.id, !e.isFeatured)} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
