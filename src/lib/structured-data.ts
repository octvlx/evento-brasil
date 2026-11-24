import { BRAND } from "@/lib/brand";
import { DEFAULT_OG_IMAGE, SITE_URL } from "@/lib/site";
import { COMPANY } from "@/content/legal/company";

/**
 * Dados estruturados (schema.org em JSON-LD) das páginas públicas, seguindo as
 * diretrizes do Google para eventos e para o nome/logo do site.
 * https://developers.google.com/search/docs/appearance/structured-data/event
 */

/** URL absoluta: capas e caminhos internos podem vir relativos ("/placeholder/…"). */
export function absoluteUrl(pathOrUrl: string, base = SITE_URL) {
  return new URL(pathOrUrl, `${base}/`).toString();
}

/** Serializa para <script type="application/ld+json"> sem permitir fechar a tag. */
export function jsonLdHtml(data: unknown) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

type City = { name: string; state: string };

export type EventJsonLdInput = {
  title: string;
  slug: string;
  summary: string | null;
  description: string;
  startsAt: Date;
  endsAt: Date;
  locationType: string;
  coverImageUrl: string | null;
  city?: City | null;
  venue?: { name: string; addressLine?: string | null; district?: string | null; postalCode?: string | null; isFictional: boolean; city?: City | null } | null;
  organization: { name: string; slug: string };
  salesStartAt: Date;
  ticketTypes: { id: string; name: string; available: number; salesStartAt?: Date | null }[];
};

/**
 * Evento à venda na plataforma. `totalCents` é o preço por ingresso já com a taxa do
 * comprador (o mesmo exibido e cobrado). Encerrado: sem ofertas.
 */
export function eventJsonLd(event: EventJsonLdInput, totalCents: Record<string, number>, opts: { ended: boolean; base?: string }) {
  const base = opts.base ?? SITE_URL;
  const url = `${base}/eventos/${event.slug}`;
  const city = event.venue?.city ?? event.city;
  const venue = event.venue && !event.venue.isFictional ? event.venue : null;
  const street = venue ? [venue.addressLine, venue.district].filter(Boolean).join(", ") : "";
  const postalCode = venue?.postalCode?.replace(/\D/g, "");

  const location =
    event.locationType === "ONLINE"
      ? { "@type": "VirtualLocation", url }
      : {
          "@type": "Place",
          // Local fictício (seed): só a cidade, sem nome nem endereço.
          name: venue?.name ?? (city ? `${city.name} – ${city.state}` : undefined),
          address: {
            "@type": "PostalAddress",
            ...(street ? { streetAddress: street } : {}),
            addressLocality: city?.name,
            addressRegion: city?.state,
            ...(postalCode?.length === 8 ? { postalCode: `${postalCode.slice(0, 5)}-${postalCode.slice(5)}` } : {}),
            addressCountry: "BR",
          },
        };

  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: event.title,
    description: event.summary ?? event.description.slice(0, 300),
    url,
    image: [absoluteUrl(event.coverImageUrl ?? DEFAULT_OG_IMAGE, base)],
    startDate: event.startsAt.toISOString(),
    endDate: event.endsAt.toISOString(),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: event.locationType === "ONLINE" ? "https://schema.org/OnlineEventAttendanceMode" : "https://schema.org/OfflineEventAttendanceMode",
    location,
    organizer: { "@type": "Organization", name: event.organization.name, url: `${base}/organizadores/${event.organization.slug}` },
    ...(opts.ended
      ? {}
      : {
          offers: event.ticketTypes.map((t) => ({
            "@type": "Offer",
            name: t.name,
            price: (totalCents[t.id] / 100).toFixed(2),
            priceCurrency: "BRL",
            availability: t.available > 0 ? "https://schema.org/InStock" : "https://schema.org/SoldOut",
            validFrom: (t.salesStartAt ?? event.salesStartAt).toISOString(),
            url,
          })),
        }),
  };
}

/** Nome e logo do site nos resultados do Google (home). */
export function siteJsonLd(base = SITE_URL) {
  const home = `${base}/`;
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${home}#website`,
      name: BRAND.name,
      alternateName: ["Ticket24", "Ticket 24"],
      url: home,
      inLanguage: "pt-BR",
      publisher: { "@id": `${home}#organization` },
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${home}#organization`,
      name: BRAND.name,
      url: home,
      logo: `${base}/icons/icon.svg`,
      description: BRAND.description,
      contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: COMPANY.supportEmail, availableLanguage: "pt-BR" },
    },
  ];
}
