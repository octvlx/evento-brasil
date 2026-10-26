import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { EventCard, type EventCardData } from "./event-card";

/** Faixa horizontal de eventos com rolagem e encaixe (vitrines da cidade). */
export function EventShelf({ id, title, count, href, events }: { id: string; title: string; count?: number; href?: string; events: EventCardData[] }) {
  const headingId = `faixa-${id}`;
  return (
    <section aria-labelledby={headingId} className="mt-12 first:mt-0">
      <div className="mb-4 flex items-end justify-between gap-4">
        <h2 id={headingId} className="font-display text-2xl font-extrabold tracking-tight">
          {title}
          {count !== undefined && <span className="ml-2 align-middle text-sm font-semibold text-muted-foreground tabular-nums">{count}</span>}
        </h2>
        {href && (
          <Link href={href} className="flex shrink-0 items-center gap-1 text-sm font-semibold text-secondary hover:underline">
            Ver todos <span className="sr-only">em {title}</span> <ArrowRight className="size-4" aria-hidden />
          </Link>
        )}
      </div>
      <ul className="scrollbar-none -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-px-4 px-4 pb-2 sm:-mx-6 sm:scroll-px-6 sm:px-6">
        {events.map((e) => (
          <li key={e.slug} className="w-[78%] max-w-80 shrink-0 snap-start sm:w-72">
            <EventCard event={e} className="h-full" />
          </li>
        ))}
      </ul>
    </section>
  );
}
