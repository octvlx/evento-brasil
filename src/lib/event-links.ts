import { formatAddress } from "@/lib/br";

/**
 * Links de mapa e de agenda da página do evento. Sem coordenadas no banco: o mapa busca
 * pelo endereço completo. A agenda usa UTC (sufixo Z), então funciona em qualquer fuso.
 */

export function mapLinks(address: string) {
  const q = encodeURIComponent(address);
  return {
    googleMaps: `https://www.google.com/maps/search/?api=1&query=${q}`,
    waze: `https://waze.com/ul?q=${q}&navigate=yes`,
  };
}

type City = { name: string; state: string };
type LocatedEvent = {
  locationType: string;
  city?: City | null;
  venue?: { name: string; addressLine?: string | null; district?: string | null; postalCode?: string | null; isFictional: boolean; city?: City | null } | null;
};

/**
 * Endereço para mapa e agenda. Null para evento online ou sem cidade. `full` leva o nome do local (agenda); `address` é só o endereço (busca do mapa).
 * `mappable` = há rua ou CEP, não só a cidade (o mapa abriria no centro dela).
 */
export function eventAddress(event: LocatedEvent) {
  const city = event.venue?.city ?? event.city;
  if (event.locationType === "ONLINE" || !city) return null;
  // Local fictício (seed): só a cidade, sem nome nem mapa.
  if (event.venue?.isFictional) {
    const cityOnly = `${city.name} – ${city.state}`;
    return { full: cityOnly, address: cityOnly, mappable: false };
  }
  const v = event.venue;
  const address = formatAddress({ addressLine: v?.addressLine, district: v?.district, city: city.name, state: city.state, postalCode: v?.postalCode });
  return { full: v?.name ? `${v.name}, ${address}` : address, address, mappable: Boolean(v?.addressLine || v?.postalCode) };
}

export type CalendarEvent = {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  url: string;
  startsAt: Date;
  endsAt: Date;
};

/** 2026-11-21T10:00:00.000Z → 20261121T100000Z */
function utcStamp(d: Date) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Texto de propriedade iCalendar (RFC 5545 §3.3.11). */
function icsText(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[;,]/g, (c) => `\\${c}`);
}

/** Dobra linhas em 75 octetos (RFC 5545 §3.1) sem partir caracteres multibyte. */
function fold(line: string) {
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const bytes = new TextEncoder().encode(ch).length;
    if (size + bytes > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function buildIcs(event: CalendarEvent, host: string, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Evento Brasil//Agenda//PT-BR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.id}@${host}`,
    `DTSTAMP:${utcStamp(now)}`,
    `DTSTART:${utcStamp(event.startsAt)}`,
    `DTEND:${utcStamp(event.endsAt)}`,
    `SUMMARY:${icsText(event.title)}`,
    `DESCRIPTION:${icsText([event.description, event.url].filter(Boolean).join("\n\n"))}`,
    ...(event.location ? [`LOCATION:${icsText(event.location)}`] : []),
    `URL:${event.url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function googleCalendarUrl(event: CalendarEvent) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${utcStamp(event.startsAt)}/${utcStamp(event.endsAt)}`,
    details: [event.description, event.url].filter(Boolean).join("\n\n"),
    ...(event.location ? { location: event.location } : {}),
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
