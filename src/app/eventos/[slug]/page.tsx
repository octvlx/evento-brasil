import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { Accessibility, CalendarDays, ChevronRight, Clock, MapPin, Share2, ShieldAlert, Users } from "lucide-react";
import { Badge, Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { EventCover } from "@/components/site/event-cover";
import { TicketSelector } from "@/features/orders/ticket-selector";
import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { getPublicEvent } from "@/server/services/catalog";
import { resolveCommissionRule } from "@/server/services/commission";
import { formatAddress } from "@/lib/br";
import { formatDateLong, formatTime, timezoneLabel } from "@/lib/datetime";
import { AVAILABILITY } from "@/lib/labels";
import { whatsappShareUrl } from "@/lib/utils";

export async function generateMetadata({ params }: PageProps<"/eventos/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const e = await db.event.findFirst({
    where: { slug, status: "PUBLISHED" },
    select: { title: true, summary: true, coverImageUrl: true, city: { select: { name: true, state: true } } },
  });
  if (!e) return { title: "Evento não encontrado" };
  const where = e.city ? ` em ${e.city.name} – ${e.city.state}` : "";
  return {
    title: `${e.title}${where}`,
    description: e.summary ?? `Ingressos para ${e.title}${where}.`,
    alternates: { canonical: `/eventos/${slug}` },
    openGraph: { title: e.title, description: e.summary ?? undefined, images: e.coverImageUrl ? [e.coverImageUrl] : undefined },
  };
}

export default function EventPage({ params }: PageProps<"/eventos/[slug]">) {
  return (
    <Suspense fallback={<EventSkeleton />}>
      <EventContent params={params} />
    </Suspense>
  );
}

function EventSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <Skeleton className="aspect-[21/9] w-full rounded-3xl" />
      <Skeleton className="mt-6 h-10 w-2/3" />
    </div>
  );
}

async function EventContent({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await connection();
  const data = await getPublicEvent(db, slug);
  if (!data) notFound();
  const { event, availability, capacityLeft, halfPriceLeft } = data;
  const user = await getCurrentUser();
  const rule = await resolveCommissionRule(db, event.organizationId, event.id);
  const now = new Date();
  const city = event.venue?.city ?? event.city;
  const tz = event.timezone;
  const base = process.env.APP_URL ?? "http://localhost:3000";
  const url = `${base}/eventos/${event.slug}`;
  const av = AVAILABILITY[availability];

  const tickets = event.ticketTypes.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    kind: t.kind,
    priceCents: t.priceCents,
    minPerOrder: t.minPerOrder,
    maxPerOrder: t.maxPerOrder,
    available: Math.max(0, Math.min(t.quantityTotal - t.quantityReserved - t.quantitySold, capacityLeft, t.kind === "HALF_PRICE" && halfPriceLeft !== null ? halfPriceLeft : Infinity)),
    onSale: now >= event.salesStartAt && now < event.salesEndAt && (!t.salesStartAt || now >= t.salesStartAt) && (!t.salesEndAt || now < t.salesEndAt),
    requiresAttendeeInfo: t.requiresAttendeeInfo,
  }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: event.title,
    description: event.summary ?? event.description.slice(0, 300),
    startDate: event.startsAt.toISOString(),
    endDate: event.endsAt.toISOString(),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: event.locationType === "ONLINE" ? "https://schema.org/OnlineEventAttendanceMode" : "https://schema.org/OfflineEventAttendanceMode",
    location:
      event.locationType === "ONLINE"
        ? { "@type": "VirtualLocation", url: event.onlineUrl }
        : { "@type": "Place", name: event.venue?.name, address: { "@type": "PostalAddress", addressLocality: city?.name, addressRegion: city?.state, addressCountry: "BR" } },
    organizer: { "@type": "Organization", name: event.organization.name },
    offers: event.ticketTypes.map((t) => ({ "@type": "Offer", name: t.name, price: (t.priceCents / 100).toFixed(2), priceCurrency: "BRL", url })),
  };

  // Trilha: Início › cidade › categoria na cidade (ou na busca, para eventos online).
  const trail = [
    { name: "Início", href: "/" },
    ...(city ? [{ name: city.name, href: `/cidades/${city.slug}` }] : []),
    { name: event.category.name, href: city ? `/cidades/${city.slug}?categoria=${event.category.slug}` : `/eventos?categoria=${event.category.slug}` },
  ];
  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [...trail, { name: event.title, href: `/eventos/${event.slug}` }].map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: `${base}${t.href}` })),
  };

  return (
    <article className="mx-auto max-w-7xl px-4 pb-10 pt-6 sm:px-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd).replace(/</g, "\\u003c") }} />
      <nav aria-label="Trilha de navegação" className="mb-4">
        <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          {trail.map((t) => (
            <li key={t.href} className="flex items-center gap-1">
              <Link href={t.href} className="rounded hover:text-foreground hover:underline">
                {t.name}
              </Link>
              <ChevronRight className="size-3.5" aria-hidden />
            </li>
          ))}
          <li aria-current="page" className="max-w-[16rem] truncate font-medium text-foreground sm:max-w-md">
            {event.title}
          </li>
        </ol>
      </nav>
      <div className="relative aspect-[16/9] overflow-hidden rounded-3xl sm:aspect-[21/9]">
        <EventCover src={event.coverImageUrl} alt={`Imagem do evento ${event.title}`} priority />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
        <div className="absolute bottom-0 p-5 text-white sm:p-8">
          <div className="mb-3 flex flex-wrap gap-2">
            <Badge className="bg-white/15 text-white backdrop-blur">{event.category.name}</Badge>
            {event.ageRestriction > 0 ? <Badge variant="accent">{event.ageRestriction}+</Badge> : <Badge className="bg-white/15 text-white">Livre</Badge>}
            {availability !== "AVAILABLE" && <Badge variant={av.tone === "danger" ? "danger" : "warning"}>{av.label}</Badge>}
          </div>
          <h1 className="max-w-4xl font-display text-3xl font-extrabold leading-tight tracking-tight sm:text-5xl">{event.title}</h1>
        </div>
      </div>

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-8">
          <div className="grid gap-4 sm:grid-cols-2">
            <Info icon={CalendarDays} title={formatDateLong(event.startsAt, tz)}>
              {formatTime(event.startsAt, tz)} às {formatTime(event.endsAt, tz)} ({timezoneLabel(event.startsAt, tz)}, horário local)
            </Info>
            <Info icon={MapPin} title={event.locationType === "ONLINE" ? "Evento online" : (event.venue?.name ?? "Local a definir")}>
              {event.locationType === "ONLINE"
                ? "O link de acesso é enviado aos compradores."
                : event.venue?.isFictional
                  ? `${city?.name} – ${city?.state} · Local fictício (evento de demonstração)`
                  : city
                    ? formatAddress({ addressLine: event.venue?.addressLine, district: event.venue?.district, city: city.name, state: city.state, postalCode: event.venue?.postalCode })
                    : null}
            </Info>
            <Info icon={Users} title={`Organizado por ${event.organization.name}`}>
              <Link href={`/organizadores/${event.organization.slug}`} className="text-secondary hover:underline">
                Ver perfil do organizador
              </Link>
            </Info>
            <Info icon={Clock} title="Vendas">
              {now < event.salesStartAt ? `Começam em ${formatDateLong(event.salesStartAt, tz)}` : `Até ${formatDateLong(event.salesEndAt, tz)}, ${formatTime(event.salesEndAt, tz)}`}
            </Info>
          </div>

          <section>
            <h2 className="mb-3 font-display text-xl font-bold">Sobre o evento</h2>
            <div className="space-y-3 whitespace-pre-line text-[15px] leading-relaxed text-foreground/90">{event.description}</div>
          </section>

          {(event.accessibilityInfo || event.venue?.accessibilityInfo) && (
            <section>
              <h2 className="mb-3 flex items-center gap-2 font-display text-xl font-bold">
                <Accessibility className="size-5 text-secondary" aria-hidden /> Acessibilidade
              </h2>
              <p className="text-[15px] text-foreground/90">{event.accessibilityInfo ?? event.venue?.accessibilityInfo}</p>
            </section>
          )}

          <section>
            <h2 className="mb-3 flex items-center gap-2 font-display text-xl font-bold">
              <ShieldAlert className="size-5 text-secondary" aria-hidden /> Política de reembolso
            </h2>
            <p className="text-[15px] text-foreground/90">{event.refundPolicy}</p>
            {event.halfPriceQuotaBps !== null && (
              <p className="mt-2 text-sm text-muted-foreground">
                Meia-entrada disponível conforme a legislação aplicável, mediante comprovação na entrada. Cota: {event.halfPriceQuotaBps / 100}% da capacidade.
              </p>
            )}
          </section>

          <a href={whatsappShareUrl(`Bora? ${event.title}`, url)} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline" })}>
            <Share2 aria-hidden /> Compartilhar no WhatsApp
          </a>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <Card className="p-5">
            <h2 className="mb-4 font-display text-xl font-bold">Ingressos</h2>
            <TicketSelector
              eventId={event.id}
              eventSlug={event.slug}
              tickets={tickets}
              buyerFee={rule.bearer === "BUYER" ? { percentBps: rule.percentBps, fixedCents: rule.fixedCentsPerTicket } : null}
              user={user ? { name: user.name, email: user.email } : null}
              halfPriceLeft={halfPriceLeft}
            />
          </Card>
        </aside>
      </div>
    </article>
  );
}

function Info({ icon: Icon, title, children }: { icon: typeof MapPin; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-border bg-card p-4">
      <Icon className="mt-0.5 size-5 shrink-0 text-secondary" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold first-letter:uppercase">{title}</p>
        {children && <div className="text-sm text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}
