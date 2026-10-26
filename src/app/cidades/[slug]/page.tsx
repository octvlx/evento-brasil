import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { CategoryChips } from "@/components/site/category-chips";
import { EventGrid, EventGridSkeleton } from "@/components/site/event-card";
import { db } from "@/server/db";
import { listCategories, searchEvents } from "@/server/services/catalog";

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
      <CityContent params={params} searchParams={searchParams as Promise<{ categoria?: string }>} />
    </Suspense>
  );
}

async function CityContent({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ categoria?: string }> }) {
  const { slug } = await params;
  const { categoria } = await searchParams;
  await connection();
  const city = await db.city.findUnique({ where: { slug } });
  if (!city) notFound();
  const [categories, res] = await Promise.all([listCategories(db), searchEvents(db, { citySlug: slug, categorySlug: categoria })]);
  return (
    <>
      <section className="bg-hero text-white">
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
          <p className="text-sm font-semibold uppercase tracking-widest text-white/70">{city.state}</p>
          <h1 className="font-display text-4xl font-extrabold tracking-tight sm:text-5xl">Eventos em {city.name}</h1>
          <p className="mt-2 text-white/80">{res.total === 1 ? "1 evento publicado" : `${res.total} eventos publicados`}</p>
          <div className="mt-6">
            <CategoryChips tone="hero" categories={categories} active={categoria} hrefFor={(c) => (c ? `/cidades/${slug}?categoria=${c}` : `/cidades/${slug}`)} />
          </div>
        </div>
      </section>
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <EventGrid events={res.events} emptyText={`Ainda não há eventos publicados em ${city.name}. Volte em breve!`} />
      </div>
    </>
  );
}
