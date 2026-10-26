import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { AtSign, BadgeCheck, Globe } from "lucide-react";
import { EventGrid, EventGridSkeleton } from "@/components/site/event-card";
import { db } from "@/server/db";
import { getPublicOrganizer } from "@/server/services/catalog";

export async function generateMetadata({ params }: PageProps<"/organizadores/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const org = await db.organization.findFirst({ where: { slug, status: "APPROVED" }, select: { name: true, description: true } });
  return org ? { title: org.name, description: org.description?.slice(0, 160) } : { title: "Organizador não encontrado" };
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
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-6 rounded-3xl border border-border bg-card p-6 sm:flex-row sm:items-center sm:p-8">
        <div className="bg-hero grid size-20 shrink-0 place-items-center rounded-2xl font-display text-3xl font-extrabold text-white">{org.name.slice(0, 1)}</div>
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-display text-3xl font-extrabold tracking-tight">
            {org.name} <BadgeCheck className="size-6 text-secondary" aria-label="Organizador verificado" />
          </h1>
          {org.city && (
            <p className="text-sm text-muted-foreground">
              {org.city.name} – {org.city.state}
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
    </div>
  );
}
