import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { db } from "@/server/db";
import { SITE_URL } from "@/lib/site";
import { listSitemapEntries } from "@/server/services/catalog";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Depende do banco e da data atual: nunca pré-renderizar no build.
  await connection();
  const { events, cities, organizers } = await listSitemapEntries(db);
  const now = new Date();
  const url = (path: string) => `${SITE_URL}${path}`;
  return [
    { url: url("/"), lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: url("/eventos"), lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: url("/ajuda"), changeFrequency: "monthly", priority: 0.3 },
    { url: url("/termos"), changeFrequency: "yearly", priority: 0.2 },
    { url: url("/privacidade"), changeFrequency: "yearly", priority: 0.2 },
    ...events.map((e) => ({ url: url(`/eventos/${e.slug}`), lastModified: e.updatedAt, changeFrequency: "daily" as const, priority: 0.8 })),
    ...cities.map((c) => ({ url: url(`/cidades/${c.slug}`), lastModified: now, changeFrequency: "daily" as const, priority: 0.7 })),
    ...organizers.map((o) => ({ url: url(`/organizadores/${o.slug}`), lastModified: o.updatedAt, changeFrequency: "weekly" as const, priority: 0.5 })),
  ];
}
