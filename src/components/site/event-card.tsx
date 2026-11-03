import Link from "next/link";
import { CalendarDays, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { formatEventDateTime } from "@/lib/datetime";
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

/** `imageSizes` liga a capa responsiva (next/image) com essa largura por breakpoint. */
export function EventCard({ event, className, priority, imageSizes }: { event: EventCardData; className?: string; priority?: boolean; imageSizes?: string }) {
  const av = AVAILABILITY[event.availability];
  const price = priceLabel(event.minPrice);
  const place = event.isOnline ? "Online" : [event.venueName, event.cityName && `${event.cityName} – ${event.state}`].filter(Boolean).join(" · ");
  return (
    <Link
      href={`/eventos/${event.slug}`}
      className={cn(
        "group flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-secondary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        <EventCover src={event.coverImageUrl} alt="" priority={priority} sizes={imageSizes} className="transition duration-500 group-hover:scale-105" />
        <div className="absolute left-3 top-3 flex gap-1.5">
          <Badge className="bg-black/55 text-white backdrop-blur">{event.categoryName}</Badge>
        </div>
        {event.availability !== "AVAILABLE" && (
          <Badge variant={av.tone === "danger" ? "danger" : av.tone === "warning" ? "warning" : "default"} className="absolute right-3 top-3 shadow">
            {av.label}
          </Badge>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-secondary">
          <CalendarDays className="size-3.5" aria-hidden />
          <time dateTime={event.startsAt.toISOString()}>{formatEventDateTime(event.startsAt, event.timezone)}</time>
        </p>
        <h3 className="line-clamp-2 font-display text-lg font-bold leading-snug">{event.title}</h3>
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="line-clamp-1">{place || "Local a definir"}</span>
        </p>
        <div className="mt-auto flex items-center justify-between pt-2">
          <span className="text-sm font-bold" data-testid="card-price">
            {price.label}
            {price.detail && <span className="block text-xs font-normal text-muted-foreground"> {price.detail}</span>}
          </span>
          {event.availability === "AVAILABLE" && <span className="text-xs font-medium text-success">{av.label}</span>}
        </div>
      </div>
    </Link>
  );
}

export function EventGrid({ events, emptyText = "Nenhum evento encontrado." }: { events: EventCardData[]; emptyText?: string }) {
  if (!events.length) {
    return <p className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">{emptyText}</p>;
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
        <div key={i} className="overflow-hidden rounded-2xl border border-border">
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
