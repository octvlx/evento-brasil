import Link from "next/link";
import { ExternalLink, MapPin } from "lucide-react";
import { eventDateStub, formatDateLong, formatEventDateTime } from "@/lib/datetime";
import { formatBRL } from "@/lib/money";
import { cn } from "@/lib/utils";
import { EventCover } from "./event-cover";

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
  /** Capa já copiada para o armazenamento da plataforma. */
  coverImageUrl?: string | null;
  source: { name: string };
}

/**
 * Card de evento vendido em outra plataforma. Da família do card nativo, sempre com
 * "Evento externo" e a fonte. `outbound`: nos destaques, o card leva direto ao link
 * externo do evento (pela saída /ir, que conta o clique e só vai à URL original).
 */
export function ExternalEventCard({ event, className, outbound, imageSizes }: { event: ExternalEventCardData; className?: string; outbound?: boolean; imageSizes?: string }) {
  const stub = eventDateStub(event.startsAt, event.timezone);
  const place = [event.venueName, event.cityName && `${event.cityName}${event.state ? ` – ${event.state}` : ""}`].filter(Boolean).join(" · ");
  const price = event.priceStatus === "FREE" ? "Gratuito" : event.priceStatus === "PAID" && event.minPriceCents ? `A partir de ${formatBRL(event.minPriceCents)}` : "Preço no site oficial";
  const cardClass = cn(
    "group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-card transition duration-300 hover:-translate-y-1 hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:hover:translate-y-0",
    className,
  );
  const body = (
    <>
      <div className={cn("relative overflow-hidden", event.coverImageUrl ? "aspect-[16/10] bg-night" : "bg-hero")}>
        {event.coverImageUrl ? (
          <>
            <EventCover src={event.coverImageUrl} alt="" sizes={imageSizes} className="transition duration-500 group-hover:scale-105 motion-reduce:group-hover:scale-100" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/20" aria-hidden />
          </>
        ) : (
          <div className="bg-dots pointer-events-none absolute inset-0" aria-hidden />
        )}
        <div className={cn("flex items-start justify-between gap-2 p-4 text-white", event.coverImageUrl && "absolute inset-x-0 top-0")}>
          <div className="relative flex min-w-11 flex-col items-center rounded-xl bg-card px-2.5 pb-1 pt-1.5 text-center leading-none text-foreground shadow-md" aria-hidden>
            <span className="font-display text-xl font-extrabold">{stub.day}</span>
            <span className="mt-0.5 text-[10px] font-bold tracking-widest text-secondary">{stub.month}</span>
          </div>
          <div className="relative flex flex-col items-end gap-1 text-right">
            <span className="rounded-full bg-lime px-2.5 py-0.5 text-xs font-bold text-night">Evento externo</span>
            <span className="rounded-full bg-night/70 px-2 py-0.5 text-xs text-white backdrop-blur">Ingressos na {event.source.name}</span>
          </div>
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
            {outbound ? `Ver na ${event.source.name}` : "Ver detalhes"} <ExternalLink className="size-3" aria-hidden />
          </span>
        </div>
      </div>
    </>
  );
  if (outbound) {
    // <a> (não Link): sem pré-carregamento; cada clique real conta uma saída.
    return (
      <a href={`/eventos-externos/${event.slug}/ir`} target="_blank" rel="nofollow noopener" className={cardClass} aria-label={`${event.title} — evento externo, abre a ${event.source.name} em nova aba`}>
        {body}
      </a>
    );
  }
  return (
    <Link href={`/eventos-externos/${event.slug}`} className={cardClass}>
      {body}
    </Link>
  );
}

/** Seção de eventos externos: só aparece com eventos; nunca mistura com os vendidos aqui. */
export function ExternalEventsSection({
  events,
  title = "Também acontecendo (ingressos em outros sites)",
  footer,
}: {
  events: ExternalEventCardData[];
  title?: string;
  footer?: React.ReactNode;
}) {
  if (!events.length) return null;
  return (
    <section aria-labelledby="externos-titulo" className="mt-12">
      <h2 id="externos-titulo" className="scroll-mt-24 font-display text-xl font-extrabold sm:text-2xl">
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">Eventos vendidos em outras plataformas. A compra é feita no site oficial de cada um.</p>
      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {events.map((e) => (
          <ExternalEventCard key={e.slug} event={e} />
        ))}
      </div>
      {footer}
    </section>
  );
}
