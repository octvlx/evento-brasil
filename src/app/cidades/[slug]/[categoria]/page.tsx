// Página categoria × cidade (ex.: /cidades/sao-paulo-sp/shows-e-musica): o recorte que as
// pessoas buscam ("shows em São Paulo"), com texto montado a partir dos dados da própria
// página, links para as outras categorias da cidade e para a categoria em outras cidades.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { ArrowRight, ChevronRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { EventGrid, EventGridSkeleton } from "@/components/site/event-card";
import { db } from "@/server/db";
import { cityCategoryOverview } from "@/server/services/catalog";
import { categoryLead, categorySummary } from "@/lib/category-copy";
import { jsonLdHtml } from "@/lib/structured-data";
import { SITE_URL } from "@/lib/site";

/** Corta na última palavra inteira (os buscadores mostram ~160 caracteres). */
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

export async function generateMetadata({ params }: PageProps<"/cidades/[slug]/[categoria]">): Promise<Metadata> {
  const { slug, categoria } = await params;
  await connection();
  const data = await cityCategoryOverview(db, slug, categoria, new Date(), 12);
  if (!data) return { title: "Página não encontrada", robots: { index: false } };
  const { city, category, total, stats } = data;
  const path = `/cidades/${city.slug}/${category.slug}`;
  // "agenda e ingressos": o que quem busca "shows em <cidade>" quer encontrar.
  const title = `${category.name} em ${city.name} – ${city.state}: agenda e ingressos`;
  const summary = categorySummary({ total, categoryName: category.name, cityName: city.name, timezone: city.timezone, stats });
  const description = clip(`${categoryLead(category.slug, category.name, city.name)} ${summary}`, 160);
  return {
    title,
    description,
    alternates: { canonical: path },
    // Sem evento à venda a página continua útil para quem chega, mas fica fora do índice.
    robots: total ? undefined : { index: false, follow: true },
    openGraph: { type: "website", title, description, url: path },
  };
}

export default function CityCategoryPage({ params }: PageProps<"/cidades/[slug]/[categoria]">) {
  return (
    <Suspense fallback={<div className="mx-auto max-w-7xl px-4 py-10 sm:px-6"><EventGridSkeleton count={8} /></div>}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: { params: Promise<{ slug: string; categoria: string }> }) {
  const { slug, categoria } = await params;
  await connection();
  const data = await cityCategoryOverview(db, slug, categoria);
  if (!data) notFound();
  const { city, category, total, events, stats, otherCategories, otherCities } = data;
  const path = `/cidades/${city.slug}/${category.slug}`;
  const trail = [
    { name: "Início", href: "/" },
    { name: city.name, href: `/cidades/${city.slug}` },
    { name: category.name, href: path },
  ];
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: `${SITE_URL}${t.href}` })),
  };
  const listLd = events.length
    ? {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: `${category.name} em ${city.name}`,
        itemListElement: events.map((e, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE_URL}/eventos/${e.slug}` })),
      }
    : null;
  const more = new URLSearchParams({ cidade: city.slug, categoria: category.slug });

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(breadcrumbLd) }} />
      {listLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdHtml(listLd) }} />}
      <section className="bg-hero text-white">
        <div className="mx-auto max-w-7xl px-4 pb-8 pt-6 sm:px-6">
          <nav aria-label="Trilha de navegação" className="mb-6">
            <ol className="flex flex-wrap items-center gap-1 text-sm text-white/75">
              {trail.slice(0, -1).map((t) => (
                <li key={t.href} className="flex items-center gap-1">
                  <Link href={t.href} className="rounded hover:text-white hover:underline">
                    {t.name}
                  </Link>
                  <ChevronRight className="size-3.5" aria-hidden />
                </li>
              ))}
              <li aria-current="page" className="font-medium text-white">
                {category.name}
              </li>
            </ol>
          </nav>
          <p className="text-sm font-semibold uppercase tracking-widest text-white/70">
            {city.name} – {city.state}
          </p>
          <h1 className="font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
            {category.name} em {city.name}
          </h1>
          <p className="mt-4 max-w-3xl text-white/90">{categoryLead(category.slug, category.name, city.name)}</p>
          <p className="mt-2 max-w-3xl text-sm text-white/80" data-testid="category-summary">
            {categorySummary({ total, categoryName: category.name, cityName: city.name, timezone: city.timezone, stats })}
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <EventGrid events={events} emptyText={`Nenhum evento de ${category.name.toLowerCase()} à venda em ${city.name} agora.`} />
        {total > events.length && (
          <div className="mt-10 text-center">
            <Link href={`/eventos?${more}`} className={buttonVariants({ variant: "outline" })}>
              Ver todos os {total} eventos <ArrowRight aria-hidden />
            </Link>
          </div>
        )}

        {otherCategories.length > 0 && (
          <section aria-labelledby="outras-categorias" className="mt-14">
            <h2 id="outras-categorias" className="mb-4 font-display text-2xl font-extrabold">
              Mais em {city.name}
            </h2>
            <ul className="flex flex-wrap gap-2">
              {otherCategories.map((c) => (
                <li key={c.slug}>
                  <Link href={`/cidades/${city.slug}/${c.slug}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    {c.name} <span className="text-muted-foreground">({c.count})</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {otherCities.length > 0 && (
          <section aria-labelledby="outras-cidades" className="mt-10">
            <h2 id="outras-cidades" className="mb-4 font-display text-2xl font-extrabold">
              {category.name} em outras cidades
            </h2>
            <ul className="flex flex-wrap gap-2">
              {otherCities.map((c) => (
                <li key={c.slug}>
                  <Link href={`/cidades/${c.slug}/${category.slug}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    {c.name} – {c.state} <span className="text-muted-foreground">({c.count})</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
