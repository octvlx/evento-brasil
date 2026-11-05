import Link from "next/link";
import { MapPin } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { eventDateStub, formatEventDateTime } from "@/lib/datetime";
import { AVAILABILITY } from "@/lib/labels";
import { priceLabel, type PriceQuote } from "@/lib/price-display";
import { cn } from "@/lib/utils";
import { EventCover } from "./event-cover";

export interface EventCardData {
  slug: string;
  title: string;
  coverImageUrl: string | null;
  startsAt: Date;
  timezone: string;
  venueName: string | null;
  cityName: string | null;
  state: string | null;
  isOnline: boolean;
  categoryName: string;
  /** Menor total por ingresso, calculado no servidor (com a taxa do comprador). */
  minPrice: PriceQuote | null;
  availability: keyof typeof AVAILABILITY;
}

const PRICE_PREFIX = "A partir de ";

/**
 * Card de evento: a capa é a protagonista; por cima dela, o "canhoto" com a data e a
 * categoria. No corpo, o que ajuda a decidir: título, quando, onde e quanto.
 * `imageSizes` liga a capa responsiva (next/image) com essa largura por breakpoint.
 */
export function EventCard({ event, className, priority, imageSizes }: { event: EventCardData; className?: string; priority?: boolean; imageSizes?: string }) {
  const av = AVAILABILITY[event.availability];
  const price = priceLabel(event.minPrice);
  const stub = eventDateStub(event.startsAt, event.timezone);
  const place = event.isOnline ? "Online" : [event.venueName, event.cityName && `${event.cityName} – ${event.state}`].filter(Boolean).join(" · ");
  const unavailable = event.availability === "SOLD_OUT" || event.availability === "CLOSED";
  return (
    <Link
      href={`/eventos/${event.slug}`}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-card transition duration-300 hover:-translate-y-1 hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:hover:translate-y-0",
        className,
      )}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-night">
        <EventCover
          src={event.coverImageUrl}
          alt=""
          priority={priority}
          sizes={imageSizes}
          className={cn("transition duration-500 group-hover:scale-105 motion-reduce:group-hover:scale-100", unavailable && "opacity-70 grayscale-[35%]")}
        />
        {/* Leve escurecido embaixo: a categoria continua legível em capas claras. */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent" aria-hidden />
        <Badge className="absolute bottom-3 left-3 bg-night/80 text-white backdrop-blur">{event.categoryName}</Badge>
        {event.availability !== "AVAILABLE" && (
          <Badge variant={av.tone === "danger" ? "danger" : av.tone === "warning" ? "warning" : "default"} className="absolute right-3 top-3 shadow">
            {av.label}
          </Badge>
        )}
        {/* Canhoto do ingresso com a data (a data completa vai no <time> abaixo, para leitores de tela). */}
        <div className="absolute left-3 top-3 flex min-w-11 flex-col items-center rounded-xl bg-card px-2.5 pb-1 pt-1.5 text-center leading-none shadow-md" aria-hidden>
          <span className="font-display text-xl font-extrabold">{stub.day}</span>
          <span className="mt-0.5 text-[10px] font-bold tracking-widest text-secondary">{stub.month}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-secondary">
          <time dateTime={event.startsAt.toISOString()}>
            <span aria-hidden>{stub.weekdayTime}</span>
            <span className="sr-only">{formatEventDateTime(event.startsAt, event.timezone)}</span>
          </time>
        </p>
        <h3 className="line-clamp-2 text-[17px] font-extrabold leading-snug tracking-tight">{event.title}</h3>
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="line-clamp-1">{place || "Local a definir"}</span>
        </p>
        <div className="mt-auto flex items-end justify-between gap-2 border-t border-dashed border-border pt-3">
          <span className="text-sm" data-testid="card-price">
            {price.label.startsWith(PRICE_PREFIX) ? (
              <>
                <span className="text-xs text-muted-foreground">{PRICE_PREFIX}</span>
                <span className="text-base font-extrabold tabular-nums">{price.label.slice(PRICE_PREFIX.length)}</span>
              </>
            ) : (
              <span className="text-base font-extrabold">{price.label}</span>
            )}
            {price.detail && <span className="block text-xs font-normal text-muted-foreground"> {price.detail}</span>}
          </span>
          {event.availability === "AVAILABLE" && (
            <span className="shrink-0 rounded-full bg-accent px-2.5 py-1 text-xs font-bold text-accent-foreground">Pegar ingresso</span>
          )}
        </div>
      </div>
    </Link>
  );
}

export function EventGrid({ events, emptyText = "Nenhum evento por aqui ainda." }: { events: EventCardData[]; emptyText?: string }) {
  if (!events.length) {
    return (
      <div className="rounded-2xl border border-dashed border-input/50 bg-card/60 p-10 text-center">
        <p className="font-display text-lg font-bold">Nada rolando por aqui… ainda.</p>
        <p className="mt-1 text-sm text-muted-foreground">{emptyText}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {events.map((e, i) => (
        <EventCard key={e.slug} event={e} priority={i < 4} />
      ))}
    </div>
  );
}

export function EventGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true" aria-label="Carregando eventos">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="aspect-[16/10] animate-pulse bg-muted" />
          <div className="space-y-2 p-4">
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-5 w-4/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}
