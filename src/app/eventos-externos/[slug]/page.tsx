import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { CalendarDays, ExternalLink, Info, MapPin, Ticket } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { ExternalViewBeacon } from "@/features/external/view-beacon";
import { EventCover } from "@/components/site/event-cover";
import { BRAND } from "@/lib/brand";
import { formatDateLong, formatDateShort, formatTime, timezoneLabel } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { SITE_URL } from "@/lib/site";
import { db } from "@/server/db";
import { getPublicExternalEvent, isIndexableExternal } from "@/server/services/external-events";

// Página de um evento vendido em outra plataforma. Só dados confirmados pela coleta,
// texto factual próprio (sem copiar descrições de terceiros), fonte visível e saída
// para o site oficial. Nada de checkout, estoque ou ingressos internos.

export async function generateMetadata({ params }: PageProps<"/eventos-externos/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  await connection();
  const e = await getPublicExternalEvent(db, slug);
  if (!e) return { title: "Evento não encontrado", robots: { index: false } };
  const where = e.cityName ? ` em ${e.cityName}${e.state ? ` – ${e.state}` : ""}` : "";
  return {
    title: `${e.title}${where}`,
    description: `${e.title}${where}, ${formatDateShort(e.startsAt, e.timezone)}. Evento externo com ingressos vendidos pela ${e.source.name}.`,
    alternates: { canonical: `/eventos-externos/${e.slug}` },
    ...(e.coverImageUrl ? { openGraph: { images: [e.coverImageUrl] } } : {}),
    // Só indexa com conteúdo suficiente (publicado, ativo, futuro, com cidade e UF).
    robots: isIndexableExternal(e) ? { index: true, follow: false } : { index: false, follow: false },
  };
}

export default function ExternalEventPage({ params }: PageProps<"/eventos-externos/[slug]">) {
  return (
    <Suspense fallback={<Skeleton className="mx-auto my-8 h-[480px] max-w-3xl" />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: { params: PageProps<"/eventos-externos/[slug]">["params"] }) {
  const { slug } = await params;
  await connection();
  const e = await getPublicExternalEvent(db, slug);
  if (!e) notFound();
  const now = new Date();
  const ended = e.startsAt.getTime() < now.getTime() - 24 * 3600_000;
  const cancelled = e.sourceStatus === "CANCELLED";
  const missing = e.sourceStatus === "MISSING";
  const when = e.hasTime ? `${formatDateLong(e.startsAt, e.timezone)}, às ${formatTime(e.startsAt, e.timezone)}` : formatDateLong(e.startsAt, e.timezone);
  const place = [e.venueName, e.cityName && `${e.cityName}${e.state ? ` – ${e.state}` : ""}`].filter(Boolean).join(" · ");
  const price = e.priceStatus === "FREE" ? "Entrada gratuita, segundo a fonte." : e.priceStatus === "PAID" && e.minPriceCents ? `A partir de ${formatBRL(e.minPriceCents)}, segundo a fonte.` : "Preço não informado aqui: confira no site oficial.";

  // Dados estruturados só com o que foi confirmado: sem preço, disponibilidade ou avaliações.
  const jsonLd = isIndexableExternal(e, now)
    ? {
        "@context": "https://schema.org",
        "@type": "Event",
        name: e.title,
        startDate: e.hasTime ? e.startsAt.toISOString() : e.startsAt.toISOString().slice(0, 10),
        eventStatus: "https://schema.org/EventScheduled",
        eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
        location: {
          "@type": "Place",
          name: e.venueName ?? e.cityName,
          address: { "@type": "PostalAddress", addressLocality: e.cityName, addressRegion: e.state, addressCountry: "BR" },
        },
        url: `${SITE_URL}/eventos-externos/${e.slug}`,
      }
    : null;

  return (
    <article className="mx-auto max-w-3xl px-4 pb-10 pt-6 sm:px-6">
      {jsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />}
      <ExternalViewBeacon slug={e.slug} />
      <nav aria-label="Trilha de navegação" className="mb-4 text-sm text-muted-foreground">
        <Link href="/eventos" className="rounded hover:text-foreground hover:underline">
          Eventos
        </Link>{" "}
        › <span className="text-foreground">Evento externo</span>
      </nav>

      <div className={`relative overflow-hidden rounded-3xl text-white ${e.coverImageUrl ? "aspect-[2/1] min-h-56 bg-night" : "bg-hero p-6 sm:p-8"}`}>
        {e.coverImageUrl ? (
          <>
            {/* Capa copiada para o armazenamento da plataforma (não carrega de terceiros). */}
            <EventCover src={e.coverImageUrl} alt={`Capa de ${e.title}`} priority />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" aria-hidden />
          </>
        ) : (
          <div className="bg-dots pointer-events-none absolute inset-0" aria-hidden />
        )}
        <div className={e.coverImageUrl ? "absolute inset-x-0 bottom-0 p-5 sm:p-8" : "relative"}>
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge className="bg-lime text-night">Evento externo</Badge>
            <Badge className="bg-white/15 text-white">Ingressos na {e.source.name}</Badge>
            {cancelled && <Badge variant="danger">Cancelado na fonte</Badge>}
            {!cancelled && ended && <Badge className="bg-white/15 text-white">Encerrado</Badge>}
          </div>
          <h1 className="font-display text-2xl font-extrabold leading-tight sm:text-4xl">{e.title}</h1>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <InfoRow icon={CalendarDays} title={when}>
          {e.hasTime ? `Horário local (${timezoneLabel(e.startsAt, e.timezone)}).` : "Horário não informado pela fonte."}
        </InfoRow>
        <InfoRow icon={MapPin} title={e.venueName ?? (place || "Local não informado")}>
          {e.venueName && e.cityName ? `${e.cityName}${e.state ? ` – ${e.state}` : ""}` : null}
        </InfoRow>
        <InfoRow icon={Ticket} title="Ingressos">
          {price}
        </InfoRow>
        <InfoRow icon={Info} title={`Vendido pela ${e.source.name}`}>
          Atualizado pela última vez em {formatDateShort(e.lastSeenAt)}.
        </InfoRow>
      </div>

      <section aria-labelledby="sobre" className="mt-6 rounded-2xl border border-border bg-card p-5 shadow-card">
        <h2 id="sobre" className="font-display text-lg font-bold">
          Sobre este evento
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-foreground/90">
          {e.title} acontece {e.hasTime ? "em" : "no dia"} {when}
          {place ? `, em ${place}` : ""}. Os ingressos são vendidos pela {e.source.name}, onde estão o horário, os valores, os setores e as regras de compra e reembolso.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          A {BRAND.name} não organiza este evento, não vende os ingressos e não é parceira da organização: mostramos as informações públicas da página oficial para ajudar você a
          encontrar o que está rolando. Confira tudo no site oficial antes de comprar.
        </p>
        {missing && <p className="mt-3 text-sm font-semibold text-warning">Este evento não apareceu na última consulta à fonte: confira se ele continua à venda.</p>}
      </section>

      <div className="mt-6 flex flex-col gap-3 rounded-2xl bg-night p-5 text-white sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-white/85">A compra é feita no site da {e.source.name}, com as condições de lá.</p>
        {/* <a> (não Link): sem pré-carregamento, cada clique real conta uma saída. */}
        <a href={`/eventos-externos/${e.slug}/ir`} rel="nofollow noopener" target="_blank" className={buttonVariants({ variant: "accent", size: "lg", className: "shrink-0" })}>
          Ver ingressos no site oficial <ExternalLink aria-hidden />
          <span className="sr-only"> (abre a {e.source.name} em nova aba)</span>
        </a>
      </div>
    </article>
  );
}

function InfoRow({ icon: Icon, title, children }: { icon: typeof MapPin; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-border bg-card p-4 shadow-card">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary/10 text-secondary">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="font-semibold first-letter:uppercase">{title}</p>
        {children && <div className="text-sm text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}
