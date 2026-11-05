import type { SafeFetchOptions } from "./safe-fetch";

/** Evento como a fonte publica, já em texto limpo. Campos ausentes ficam ausentes. */
export interface ExternalEventInput {
  sourceEventId: string;
  sourceUrl: string;
  title: string;
  /** Data local no fuso do evento (YYYY-MM-DD). */
  localDate: string;
  /** Hora local (HH:mm) só quando a fonte informa. */
  localTime: string | null;
  venueName: string | null;
  cityName: string | null;
  /** UF de duas letras, quando reconhecida. */
  state: string | null;
  categoryName: string | null;
  price: { status: "UNKNOWN" } | { status: "FREE" } | { status: "PAID"; minPriceCents: number | null };
  cancelled: boolean;
}

export interface DiscoveredEvent {
  sourceEventId: string;
  url: string;
}

export interface Fetcher {
  html(url: string): Promise<{ url: string; html: string }>;
}

/** Adaptador de uma fonte. Cada fonte tem o seu; nenhum compartilha seletores. */
export interface ExternalSourceAdapter {
  key: string;
  /** Hosts exatos permitidos para coleta e para o botão "Ver ingressos no site oficial". */
  allowedHosts: readonly string[];
  fetchOptions?: Partial<SafeFetchOptions>;
  /** Lista de eventos (até `maxEvents`). `complete` = a listagem inteira foi lida. */
  discover(fetcher: Fetcher, limits: { maxPages: number; maxEvents: number }): Promise<{ events: DiscoveredEvent[]; pagesFetched: number; complete: boolean }>;
  /** Dados de um evento a partir da página dele. */
  parseEvent(html: string, discovered: DiscoveredEvent): ExternalEventInput;
}
