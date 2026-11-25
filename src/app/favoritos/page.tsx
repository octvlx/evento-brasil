import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/primitives";
import { EventGrid } from "@/components/site/event-card";
import { FollowOrganizerButton } from "@/features/favorites/toggle-buttons";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { favoriteEvents } from "@/server/services/catalog";
import { followedOrganizers } from "@/server/services/favorites";

export const metadata: Metadata = { title: "Favoritos", robots: { index: false } };

export default function FavoritesPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">Favoritos</h1>
      <Suspense fallback={<Skeleton className="mt-6 h-96" />}>
        <Favorites />
      </Suspense>
    </div>
  );
}

async function Favorites() {
  const user = await requireUser("/favoritos");
  const [events, orgs] = await Promise.all([favoriteEvents(db, user.id), followedOrganizers(db, user.id)]);
  return (
    <>
      <section aria-labelledby="eventos-salvos" className="mt-6">
        <h2 id="eventos-salvos" className="mb-4 font-display text-xl font-extrabold">Eventos salvos</h2>
        <EventGrid events={events} emptyText="Nenhum evento salvo. Toque em “Salvar nos favoritos” na página de um evento." />
      </section>
      <section aria-labelledby="organizadores-seguidos" className="mt-10">
        <h2 id="organizadores-seguidos" className="font-display text-xl font-extrabold">Organizadores que você segue</h2>
        <p className="mb-4 text-sm text-muted-foreground">Você recebe um e-mail quando eles publicam um evento novo.</p>
        {orgs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Você ainda não segue nenhum organizador.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {orgs.map((o) => (
              <li key={o.id} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4">
                {o.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={o.logoUrl} alt="" className="size-12 shrink-0 rounded-xl border border-border bg-white object-cover" />
                ) : (
                  <div className="bg-hero grid size-12 shrink-0 place-items-center rounded-xl font-display text-xl font-extrabold text-white">{o.name.slice(0, 1)}</div>
                )}
                <div className="min-w-0 flex-1">
                  <Link href={`/organizadores/${o.slug}`} className="block truncate font-semibold hover:underline">
                    {o.name}
                  </Link>
                  {o.city && <p className="text-xs text-muted-foreground">{o.city.name} – {o.city.state}</p>}
                </div>
                <FollowOrganizerButton id={o.id} initial loggedIn />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
