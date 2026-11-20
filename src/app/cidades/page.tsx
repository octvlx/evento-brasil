import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { MapPin, Star } from "lucide-react";
import { Skeleton } from "@/components/ui/primitives";
import { BackButton } from "@/components/site/back-button";
import { db } from "@/server/db";
import { cityOverview } from "@/server/services/catalog";
import { UFS } from "@/lib/br";
import { DEFAULT_OG_IMAGE } from "@/lib/site";

const DESCRIPTION = "Cidades com eventos à venda na QQPega: escolha a sua e veja shows, festas, teatro e mais.";

export const metadata: Metadata = {
  title: "Cidades",
  description: DESCRIPTION,
  alternates: { canonical: "/cidades" },
  openGraph: { type: "website", title: "Cidades com eventos", description: DESCRIPTION, url: "/cidades", images: [DEFAULT_OG_IMAGE] },
};

export default function CitiesPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <BackButton className="-ml-2 mb-3" />
      <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Cidades</h1>
      <p className="mt-2 text-muted-foreground">Escolha a cidade para ver o que está rolando por lá.</p>
      <Suspense fallback={<Skeleton className="mt-8 h-96" />}>
        <Overview />
      </Suspense>
    </div>
  );
}

async function Overview() {
  await connection();
  const cities = await cityOverview(db);
  if (!cities.length) return <p className="mt-8 text-muted-foreground">Ainda não há cidades com eventos publicados.</p>;
  const featured = cities.filter((c) => c.isFeatured);
  const label = (n: number) => (n === 1 ? "1 evento" : `${n} eventos`);
  return (
    <>
      {featured.length > 0 && (
        <section aria-labelledby="cidades-destaque" className="mt-8">
          <h2 id="cidades-destaque" className="mb-3 flex items-center gap-2 font-display text-xl font-bold">
            <Star className="size-5 text-secondary" aria-hidden /> Em destaque
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {featured.map((c) => (
              <li key={c.id}>
                <Link href={`/cidades/${c.slug}`} className="bg-hero flex h-full flex-col justify-between rounded-2xl p-4 text-white shadow-card hover:opacity-95">
                  <span className="font-display text-lg font-extrabold">{c.name}</span>
                  <span className="mt-2 text-sm text-white/80">
                    {c.state} · {c.events ? label(c.events) : "eventos em outros sites"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="cidades-todas" className="mt-10">
        <h2 id="cidades-todas" className="mb-3 font-display text-xl font-bold">
          Todas as cidades
        </h2>
        <div className="columns-1 gap-6 sm:columns-2 lg:columns-3">
          {UFS.map((uf) => {
            const list = cities.filter((c) => c.state === uf.uf);
            if (!list.length) return null;
            return (
              <div key={uf.uf} className="mb-6 break-inside-avoid">
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {uf.name} ({uf.uf})
                </h3>
                <ul className="space-y-1">
                  {list.map((c) => (
                    <li key={c.id}>
                      <Link href={`/cidades/${c.slug}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted">
                        <span className="flex items-center gap-1.5">
                          <MapPin className="size-3.5 text-secondary" aria-hidden /> {c.name}
                        </span>
                        <span className="text-xs text-muted-foreground">{c.events ? label(c.events) : "outros sites"}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
