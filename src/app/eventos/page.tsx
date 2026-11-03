import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { SlidersHorizontal } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Select } from "@/components/ui/primitives";
import { EventGrid, EventGridSkeleton } from "@/components/site/event-card";
import { db } from "@/server/db";
import { listCategories, listCities, searchEvents, type DateFilter, type PriceFilter } from "@/server/services/catalog";
import { DEFAULT_OG_IMAGE } from "@/lib/site";
import { UFS } from "@/lib/br";

const EVENTS_DESCRIPTION = "Busque eventos por cidade, categoria, data e preço em todo o Brasil.";

// searchParams só é lido aqui (generateMetadata), nunca no nível da página.
export async function generateMetadata({ searchParams }: PageProps<"/eventos">): Promise<Metadata> {
  const sp = await searchParams;
  const filtered = Object.keys(sp).length > 0;
  return {
    title: "Explorar eventos",
    description: EVENTS_DESCRIPTION,
    alternates: { canonical: "/eventos" },
    openGraph: { type: "website", title: "Explorar eventos", description: EVENTS_DESCRIPTION, url: "/eventos", images: [DEFAULT_OG_IMAGE] },
    ...(filtered ? { robots: { index: false, follow: true } } : {}),
  };
}

const DATE_OPTIONS: [DateFilter, string][] = [
  ["hoje", "Hoje"],
  ["amanha", "Amanhã"],
  ["fim-de-semana", "Fim de semana"],
  ["7-dias", "Próximos 7 dias"],
  ["30-dias", "Próximos 30 dias"],
];
const PRICE_OPTIONS: [PriceFilter, string][] = [
  ["gratis", "Gratuito"],
  ["ate-50", "Até R$ 50"],
  ["50-150", "R$ 50 a R$ 150"],
  ["150-mais", "Acima de R$ 150"],
];

type Search = { q?: string; cidade?: string; categoria?: string; data?: string; preco?: string; pagina?: string };

export default function EventsPage({ searchParams }: PageProps<"/eventos">) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Explorar eventos</h1>
      <Suspense fallback={<div className="mt-6 h-24 rounded-2xl bg-muted" />}>
        <Filters searchParams={searchParams as Promise<Search>} />
      </Suspense>
      <div className="mt-8">
        <Suspense fallback={<EventGridSkeleton count={8} />}>
          <Results searchParams={searchParams as Promise<Search>} />
        </Suspense>
      </div>
    </div>
  );
}

const pick = <T extends string>(v: string | undefined, options: [T, string][]) => options.find(([k]) => k === v)?.[0];

async function Filters({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  // Cidades com evento no ar agora: lidas a cada pedido.
  await connection();
  const [cities, categories] = await Promise.all([listCities(db), listCategories(db)]);
  return (
    <form className="mt-6 grid gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1.3fr_1.2fr_1.1fr_1.1fr_auto]" role="search">
      <input
        name="q"
        type="search"
        defaultValue={sp.q}
        placeholder="Buscar por nome, local ou organizador"
        aria-label="Buscar"
        className="h-11 rounded-xl border border-input bg-card px-3.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Select name="cidade" defaultValue={sp.cidade ?? ""} aria-label="Cidade">
        <option value="">Todas as cidades</option>
        {UFS.map((uf) => {
          const list = cities.filter((c) => c.state === uf.uf);
          return list.length ? (
            <optgroup key={uf.uf} label={`${uf.name} (${uf.uf})`}>
              {list.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </Select>
      <Select name="categoria" defaultValue={sp.categoria ?? ""} aria-label="Categoria">
        <option value="">Todas as categorias</option>
        {categories.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select name="data" defaultValue={sp.data ?? ""} aria-label="Data">
        <option value="">Qualquer data</option>
        {DATE_OPTIONS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </Select>
      <Select name="preco" defaultValue={sp.preco ?? ""} aria-label="Preço">
        <option value="">Qualquer preço</option>
        {PRICE_OPTIONS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </Select>
      <button className={buttonVariants({ variant: "secondary" })}>
        <SlidersHorizontal aria-hidden /> Filtrar
      </button>
    </form>
  );
}

async function Results({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  await connection();
  const page = Math.max(1, Number(sp.pagina) || 1);
  const res = await searchEvents(db, {
    q: sp.q,
    citySlug: sp.cidade || undefined,
    categorySlug: sp.categoria || undefined,
    date: pick(sp.data, DATE_OPTIONS),
    price: pick(sp.preco, PRICE_OPTIONS),
    page,
  });
  const qs = (p: number) => {
    const params = new URLSearchParams(Object.entries(sp).filter(([k, v]) => k !== "pagina" && typeof v === "string" && v) as [string, string][]);
    params.set("pagina", String(p));
    return `/eventos?${params}`;
  };
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground" aria-live="polite">
        {res.total === 1 ? "1 evento encontrado" : `${res.total} eventos encontrados`}
      </p>
      <EventGrid events={res.events} emptyText="Nenhum evento com esses filtros. Tente ampliar a data ou trocar a cidade." />
      {res.pageCount > 1 && (
        <nav className="mt-8 flex items-center justify-center gap-2" aria-label="Paginação">
          {page > 1 && (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={qs(page - 1)}>
              Anterior
            </Link>
          )}
          <span className="text-sm text-muted-foreground">
            Página {page} de {res.pageCount}
          </span>
          {page < res.pageCount && (
            <Link className={buttonVariants({ variant: "outline", size: "sm" })} href={qs(page + 1)}>
              Próxima
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
