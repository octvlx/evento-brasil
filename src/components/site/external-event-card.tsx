import Link from "next/link";
import { ExternalLink, MapPin } from "lucide-react";
import { eventDateStub, formatDateLong, formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { cn } from "@/lib/utils";

export interface ExternalEventCardData {
  slug: string;
  title: string;
  startsAt: Date;
  hasTime: boolean;
  timezone: string;
  venueName: string | null;
  cityName: string | null;
  state: string | null;
  priceStatus: "UNKNOWN" | "FREE" | "PAID";
  minPriceCents: number | null;
  source: { name: string };
}

/**
 * Card de evento vendido em outra plataforma. Visualmente da família do card nativo,
 * mas sem capa (imagens de terceiros não são importadas) e sempre com "Evento externo"
 * e a fonte. Leva à página do evento externo, que leva ao site oficial.
 */
export function ExternalEventCard({ event, className }: { event: ExternalEventCardData; className?: string }) {
  const stub = eventDateStub(event.startsAt, event.timezone);
  const place = [event.venueName, event.cityName && `${event.cityName}${event.state ? ` – ${event.state}` : ""}`].filter(Boolean).join(" · ");
  const price = event.priceStatus === "FREE" ? "Gratuito" : event.priceStatus === "PAID" && event.minPriceCents ? `A partir de ${formatBRL(event.minPriceCents)}` : "Preço no site oficial";
  return (
    <Link
      href={`/eventos-externos/${event.slug}`}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-card transition duration-300 hover:-translate-y-1 hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:hover:translate-y-0",
        className,
      )}
    >
      <div className="bg-hero relative flex items-start justify-between gap-2 p-4 text-white">
        <div className="bg-dots pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative flex min-w-11 flex-col items-center rounded-xl bg-card px-2.5 pb-1 pt-1.5 text-center leading-none text-foreground shadow-md" aria-hidden>
          <span className="font-display text-xl font-extrabold">{stub.day}</span>
          <span className="mt-0.5 text-[10px] font-bold tracking-widest text-secondary">{stub.month}</span>
        </div>
        <div className="relative flex flex-col items-end gap-1 text-right">
          <span className="rounded-full bg-lime px-2.5 py-0.5 text-xs font-bold text-night">Evento externo</span>
          <span className="text-xs text-white/80">Ingressos na {event.source.name}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-secondary">
          <time dateTime={event.hasTime ? event.startsAt.toISOString() : event.startsAt.toISOString().slice(0, 10)}>
            <span aria-hidden>{event.hasTime ? stub.weekdayTime : `${stub.weekdayTime.split(" · ")[0]} · horário no site`}</span>
            <span className="sr-only">{event.hasTime ? formatEventDateTime(event.startsAt, event.timezone) : `${formatDateLong(event.startsAt, event.timezone)}, horário não informado`}</span>
          </time>
        </p>
        <h3 className="line-clamp-2 text-[17px] font-extrabold leading-snug tracking-tight">{event.title}</h3>
        <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
          <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="line-clamp-1">{place || "Local no site oficial"}</span>
        </p>
        <div className="mt-auto flex items-end justify-between gap-2 border-t border-dashed border-border pt-3">
          <span className="text-sm font-bold">{price}</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-secondary">
            Ver detalhes <ExternalLink className="size-3" aria-hidden />
          </span>
        </div>
      </div>
    </Link>
  );
}

/** Seção "Em outros sites": só aparece com eventos; nunca mistura com os vendidos aqui. */
export function ExternalEventsSection({ events, title = "Também acontecendo (ingressos em outros sites)" }: { events: ExternalEventCardData[]; title?: string }) {
  if (!events.length) return null;
  return (
    <section aria-labelledby="externos-titulo" className="mt-12">
      <h2 id="externos-titulo" className="font-display text-xl font-extrabold sm:text-2xl">
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Eventos vendidos em outras plataformas. A compra é feita no site oficial de cada um.</p>
      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {events.map((e) => (
          <ExternalEventCard key={e.slug} event={e} />
        ))}
      </div>
    </section>
  );
}
