import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { AtSign, BadgeCheck, Globe } from "lucide-react";
import { EventGrid, EventGridSkeleton } from "@/components/site/event-card";
import { db } from "@/server/db";
import { getPublicOrganizer, pastOrganizerEvents } from "@/server/services/catalog";
import { DEFAULT_OG_IMAGE } from "@/lib/site";
import { Stars } from "@/features/reviews/review-form";
import { organizerReviewSummary } from "@/server/services/reviews";
import { formatDateShort } from "@/lib/datetime";

export async function generateMetadata({ params }: PageProps<"/organizadores/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const org = await db.organization.findFirst({ where: { slug, status: "APPROVED" }, select: { name: true, description: true, coverUrl: true, logoUrl: true } });
  if (!org) return { title: "Organizador não encontrado", robots: { index: false } };
  const description = org.description?.slice(0, 160) ?? `Eventos de ${org.name} na TICKET24. Compre ingressos com PIX ou cartão.`;
  return {
    title: org.name,
    description,
    alternates: { canonical: `/organizadores/${slug}` },
    // Capa (ou logo) do organizador; sem imagem própria, a padrão (um openGraph na página substitui o herdado).
    openGraph: { type: "website", title: org.name, description, url: `/organizadores/${slug}`, images: [org.coverUrl ?? org.logoUrl ?? DEFAULT_OG_IMAGE] },
  };
}

export default function OrganizerPage({ params }: PageProps<"/organizadores/[slug]">) {
  return (
    <Suspense fallback={<div className="mx-auto max-w-7xl px-4 py-10 sm:px-6"><EventGridSkeleton /></div>}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await connection();
  const data = await getPublicOrganizer(db, slug);
  if (!data) notFound();
  const { org, events } = data;
  const [past, reviews] = await Promise.all([pastOrganizerEvents(db, org.id), organizerReviewSummary(db, org.id)]);
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      {org.coverUrl && (
        <div className="mb-4 aspect-[4/1] w-full overflow-hidden rounded-3xl border border-border bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={org.coverUrl} alt="" className="h-full w-full object-cover" fetchPriority="high" />
        </div>
      )}
      <div className="flex flex-col gap-6 rounded-3xl border border-border bg-card p-6 sm:flex-row sm:items-center sm:p-8">
        {org.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logoUrl} alt={`Logo de ${org.name}`} className="size-20 shrink-0 rounded-2xl border border-border bg-white object-cover" />
        ) : (
          <div className="bg-hero grid size-20 shrink-0 place-items-center rounded-2xl font-display text-3xl font-extrabold text-white">{org.name.slice(0, 1)}</div>
        )}
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-display text-3xl font-extrabold tracking-tight">
            {org.name} <BadgeCheck className="size-6 text-secondary" aria-label="Organizador verificado" />
          </h1>
          {org.city && (
            <p className="text-sm text-muted-foreground">
              {org.city.name} – {org.city.state}
            </p>
          )}
          {reviews.count > 0 && reviews.average != null && (
            <p className="mt-1 flex items-center gap-2 text-sm" data-testid="organizer-rating">
              <Stars value={reviews.average} />
              <span className="font-semibold">{reviews.average.toLocaleString("pt-BR", { minimumFractionDigits: 1 })}</span>
              <a href="#avaliacoes" className="text-muted-foreground hover:underline">
                ({reviews.count} {reviews.count === 1 ? "avaliação" : "avaliações"} de quem foi)
              </a>
            </p>
          )}
          {org.description && <p className="mt-2 max-w-3xl text-sm">{org.description}</p>}
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            {org.websiteUrl && (
              <a href={org.websiteUrl} rel="noopener noreferrer nofollow" target="_blank" className="flex items-center gap-1 text-secondary hover:underline">
                <Globe className="size-4" aria-hidden /> Site
              </a>
            )}
            {org.instagramHandle && (
              <a href={`https://instagram.com/${org.instagramHandle}`} rel="noopener noreferrer nofollow" target="_blank" className="flex items-center gap-1 text-secondary hover:underline">
                <AtSign className="size-4" aria-hidden /> Instagram: {org.instagramHandle}
              </a>
            )}
          </div>
        </div>
      </div>
      <h2 className="mb-5 mt-10 font-display text-2xl font-extrabold">Próximos eventos</h2>
      <EventGrid events={events} emptyText="Nenhum evento publicado no momento." />
      {past.length > 0 && (
        <section aria-labelledby="eventos-anteriores" className="mt-12">
          <h2 id="eventos-anteriores" className="mb-5 font-display text-2xl font-extrabold">
            Eventos anteriores
          </h2>
          <EventGrid events={past} emptyText="" />
        </section>
      )}
      {reviews.recent.length > 0 && (
        <section id="avaliacoes" aria-labelledby="avaliacoes-titulo" className="mt-12 scroll-mt-24">
          <h2 id="avaliacoes-titulo" className="mb-1 font-display text-2xl font-extrabold">
            Avaliações
          </h2>
          <p className="mb-5 text-sm text-muted-foreground">Só quem entrou no evento pode avaliar.</p>
          <ul className="grid gap-4 md:grid-cols-2">
            {reviews.recent.map((r) => (
              <li key={r.id} className="rounded-2xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Stars value={r.rating} />
                  <span className="text-xs text-muted-foreground">{formatDateShort(r.createdAt)}</span>
                </div>
                <p className="mt-3 whitespace-pre-line text-sm">{r.comment}</p>
                <p className="mt-3 text-xs text-muted-foreground">
                  {r.author} · <a href={`/eventos/${r.event.slug}`} className="hover:underline">{r.event.title}</a>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
