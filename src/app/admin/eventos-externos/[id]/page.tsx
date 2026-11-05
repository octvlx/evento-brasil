import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ExternalLink } from "lucide-react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { AdminActionButton } from "@/features/admin/controls";
import { DeleteExternalEventButton, ExternalCoverTool } from "@/features/admin/external-controls";
import { featureExternalEventAction, reviewExternalEventAction } from "@/features/admin/actions";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { AppError } from "@/server/errors";
import { formatDateShort, formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { adminGetExternalEvent } from "@/server/services/external-events";

export const metadata: Metadata = { title: "Evento externo — admin", robots: { index: false } };

const REVIEW = { PENDING_REVIEW: "Em revisão", PUBLISHED: "Publicado", HIDDEN: "Oculto" } as const;

export default function AdminExternalEventPage({ params }: PageProps<"/admin/eventos-externos/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: { params: PageProps<"/admin/eventos-externos/[id]">["params"] }) {
  const admin = await requireAdmin("events:moderate");
  const { id } = await params;
  const e = await adminGetExternalEvent(db, admin, id).catch((err) => {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  });
  const place = [e.venueName, e.cityName && `${e.cityName} – ${e.state ?? "?"}`].filter(Boolean).join(" · ") || "Local não informado";
  const price = e.priceStatus === "FREE" ? "Gratuito" : e.priceStatus === "PAID" ? (e.minPriceCents ? `A partir de ${formatBRL(e.minPriceCents)}` : "Pago") : "Não informado";

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/admin/eventos-externos?aba=${e.review}`} className="text-secondary hover:underline">
          ← Eventos externos
        </Link>
      </p>
      <PageTitle title={e.title} subtitle={`Fonte: ${e.source.name}. Dados públicos coletados da página original; a compra acontece lá.`} />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section aria-labelledby="capa" className="rounded-2xl border border-border bg-card p-5 shadow-card">
          <h2 id="capa" className="mb-3 font-display text-lg font-bold">
            Capa
          </h2>
          <ExternalCoverTool eventId={e.id} current={e.coverImageUrl} sourceUrl={e.sourceUrl} />
        </section>

        <aside className="space-y-4">
          <section aria-labelledby="situacao" className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-card">
            <h2 id="situacao" className="font-display text-lg font-bold">
              Situação
            </h2>
            <p className="flex flex-wrap gap-2">
              <Badge variant={e.review === "PUBLISHED" ? "success" : e.review === "HIDDEN" ? "default" : "warning"}>{REVIEW[e.review]}</Badge>
              {e.isFeatured && <Badge variant="success">Em destaque</Badge>}
              {e.sourceStatus !== "ACTIVE" && <Badge variant="warning">{e.sourceStatus === "CANCELLED" ? "Cancelado na fonte" : "Não visto na última coleta"}</Badge>}
            </p>
            <div className="flex flex-wrap gap-2">
              {e.review !== "PUBLISHED" && <AdminActionButton label="Publicar" variant="secondary" action={reviewExternalEventAction.bind(null, e.id, "PUBLISHED")} />}
              {e.review !== "HIDDEN" && <AdminActionButton label="Ocultar" action={reviewExternalEventAction.bind(null, e.id, "HIDDEN")} />}
              {e.review !== "PENDING_REVIEW" && <AdminActionButton label="Voltar para revisão" variant="ghost" action={reviewExternalEventAction.bind(null, e.id, "PENDING_REVIEW")} />}
            </div>
            {e.review === "PUBLISHED" ? (
              <AdminActionButton
                label={e.isFeatured ? "Remover destaque" : "Destacar"}
                variant={e.isFeatured ? "ghost" : "secondary"}
                action={featureExternalEventAction.bind(null, e.id, !e.isFeatured)}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Publique o evento para poder destacá-lo.</p>
            )}
            <DeleteExternalEventButton eventId={e.id} />
          </section>

          <section aria-labelledby="dados" className="space-y-1 rounded-2xl border border-border bg-card p-5 text-sm shadow-card">
            <h2 id="dados" className="mb-2 font-display text-lg font-bold">
              Dados da fonte
            </h2>
            <p>{e.hasTime ? formatEventDateTime(e.startsAt, e.timezone) : `${formatDateShort(e.startsAt, e.timezone)} (horário não informado)`}</p>
            <p>{place}</p>
            <p>Preço: {price}</p>
            <p className="text-muted-foreground">
              {e.viewCount} visualizações · {e.outboundClicks} cliques de saída
            </p>
            {e.review === "PUBLISHED" && (
              <p>
                <Link href={`/eventos-externos/${e.slug}`} className="text-secondary hover:underline">
                  Ver página pública
                </Link>
              </p>
            )}
            <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-secondary hover:underline">
              Conferir página original <ExternalLink className="size-3" aria-hidden />
            </a>
          </section>
        </aside>
      </div>
    </>
  );
}
