import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { CategoryChips } from "@/components/site/category-chips";
import { EventGrid, EventGridSkeleton } from "@/components/site/event-card";
import { EventShelf } from "@/components/site/event-shelf";
import { db } from "@/server/db";
import { cityShowcase, listCategories, searchEvents, type DateFilter } from "@/server/services/catalog";
import { cn } from "@/lib/utils";

type CitySearch = { categoria?: string; data?: string };

// Recortes de data da página da cidade (mesmos valores do filtro de /eventos).
const PERIODS: [DateFilter, string][] = [
  ["hoje", "Hoje"],
  ["amanha", "Amanhã"],
  ["fim-de-semana", "Fim de semana"],
];

export async function generateMetadata({ params }: PageProps<"/cidades/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const city = await db.city.findUnique({ where: { slug } });
  if (!city) return { title: "Cidade não encontrada" };
  return {
    title: `Eventos em ${city.name} – ${city.state}`,
    description: `Shows, festas, teatro e mais em ${city.name} (${city.state}). Compre ingressos com PIX ou cartão.`,
    alternates: { canonical: `/cidades/${city.slug}` },
  };
}

export default function CityPage({ params, searchParams }: PageProps<"/cidades/[slug]">) {
  return (
    <Suspense fallback={<div className="mx-auto max-w-7xl px-4 py-10 sm:px-6"><EventGridSkeleton count={8} /></div>}>
      <CityContent params={params} searchParams={searchParams as Promise<CitySearch>} />
    </Suspense>
  );
}

function cityHref(slug: string, q: CitySearch) {
  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
  const s = params.toString();
  return s ? `/cidades/${slug}?${s}` : `/cidades/${slug}`;
}

async function CityContent({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<CitySearch> }) {
  const { slug } = await params;
  const sp = await searchParams;
  await connection();
  const city = await db.city.findUnique({ where: { slug } });
  if (!city) notFound();
  const categories = await listCategories(db);
  const categoria = categories.some((c) => c.slug === sp.categoria) ? sp.categoria : undefined;
  const data = PERIODS.find(([v]) => v === sp.data)?.[0];
  const filtered = Boolean(categoria || data);

  return (
    <>
      <section className="bg-hero text-white">
        <div className="mx-auto max-w-7xl px-4 pb-8 pt-12 sm:px-6">
          <p className="text-sm font-semibold uppercase tracking-widest text-white/70">{city.state}</p>
          <h1 className="font-display text-4xl font-extrabold tracking-tight sm:text-5xl">Eventos em {city.name}</h1>
          <nav aria-label="Quando" className="scrollbar-none mt-6 inline-flex max-w-full overflow-x-auto rounded-full bg-white/10 p-1 ring-1 ring-white/20 backdrop-blur">
            {[[undefined, "Tudo"] as const, ...PERIODS].map(([value, label]) => (
              <Link
                key={label}
                href={cityHref(slug, { categoria, data: value })}
                aria-current={data === value ? "page" : undefined}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-semibold transition",
                  data === value ? "bg-white text-primary shadow" : "text-white/85 hover:bg-white/15 hover:text-white",
                )}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="mt-4">
            <CategoryChips tone="hero" categories={categories} active={categoria} hrefFor={(c) => cityHref(slug, { categoria: c, data })} />
          </div>
        </div>
      </section>
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        {filtered ? <FilteredResults slug={slug} cityName={city.name} categoria={categoria} data={data} /> : <Showcase slug={slug} cityName={city.name} />}
      </div>
    </>
  );
}

async function Showcase({ slug, cityName }: { slug: string; cityName: string }) {
  const { total, featured, shelves } = await cityShowcase(db, slug);
  if (!total) return <EventGrid events={[]} emptyText={`Ainda não há eventos publicados em ${cityName}. Volte em breve!`} />;
  return (
    <>
      <p className="mb-8 text-muted-foreground">{total === 1 ? "1 evento publicado" : `${total} eventos publicados`}</p>
      {featured.length > 0 && <EventShelf id="destaques" title={`Em destaque em ${cityName}`} events={featured} />}
      {shelves.map((s) => (
        <EventShelf key={s.category.slug} id={s.category.slug} title={s.category.name} count={s.total} href={cityHref(slug, { categoria: s.category.slug })} events={s.events} />
      ))}
      <div className="mt-12 text-center">
        <Link href={`/eventos?cidade=${slug}`} className={buttonVariants({ variant: "outline" })}>
          Buscar com mais filtros <ArrowRight aria-hidden />
        </Link>
      </div>
    </>
  );
}

async function FilteredResults({ slug, cityName, categoria, data }: { slug: string; cityName: string; categoria?: string; data?: DateFilter }) {
  const res = await searchEvents(db, { citySlug: slug, categorySlug: categoria, date: data });
  const more = new URLSearchParams(Object.entries({ cidade: slug, categoria, data }).filter(([, v]) => v) as [string, string][]);
  return (
    <>
      <p className="mb-6 text-muted-foreground" aria-live="polite">
        {res.total === 1 ? "1 evento encontrado" : `${res.total} eventos encontrados`}
      </p>
      <EventGrid events={res.events} emptyText={`Nenhum evento em ${cityName} com esses filtros. Tente outro dia ou categoria.`} />
      {res.pageCount > 1 && (
        <div className="mt-10 text-center">
          <Link href={`/eventos?${more}`} className={buttonVariants({ variant: "outline" })}>
            Ver todos os {res.total} eventos <ArrowRight aria-hidden />
          </Link>
        </div>
      )}
    </>
  );
}
