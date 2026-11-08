import { UFS } from "@/lib/br";
import { cleanText, htmlToLines, metaContent } from "../text";
import type { DiscoveredEvent, ExternalEventInput, ExternalSourceAdapter } from "../types";

// Duoticket (https://duoticket.com.br). Verificado em 05/11/2026:
// - robots.txt permite tudo, exceto /validador/;
// - a home lista os próximos eventos em HTML (links "evento/{id}/{nome}");
// - a página do evento traz, em HTML, o título, "DATA" (dd/mm/aaaa, sem horário) e
//   "LOCAL" (nome do local e "Cidade | Estado");
// - preço e lotes são carregados por JavaScript de endpoints internos: não usamos;
// - termos: proíbem copiar marcas, logotipos, interface e software. Não coletamos imagem,
//   descrição nem marca; só dados factuais e a URL.

const HOST = "duoticket.com.br";
const HOME = `https://${HOST}/`;
const EVENT_PATH = /(?:https:\/\/(?:www\.)?duoticket\.com\.br\/|\/|^)evento\/(\d{1,9})\/([A-Za-z0-9\-_.~%]{1,150})/;

const STATE_BY_NAME = new Map(UFS.map((u) => [normalize(u.name), u.uf]));

function normalize(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Lista da home: ids únicos na ordem em que aparecem. */
export function parseDuoticketListing(html: string, maxEvents: number): DiscoveredEvent[] {
  const seen = new Set<string>();
  const out: DiscoveredEvent[] = [];
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    const hit = EVENT_PATH.exec(href);
    if (!hit) continue;
    // Links absolutos só do próprio domínio; relativos são resolvidos na home.
    if (/^https?:/i.test(href) && !/^https:\/\/(www\.)?duoticket\.com\.br\//i.test(href)) continue;
    const id = hit[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ sourceEventId: id, url: `${HOME}evento/${id}/${hit[2]}` });
    if (out.length >= maxEvents) break;
  }
  return out;
}

function valueAfter(lines: string[], label: RegExp, take = 1): string[] {
  const i = lines.findIndex((l) => label.test(l));
  return i < 0 ? [] : lines.slice(i + 1, i + 1 + take);
}

export function parseDuoticketEvent(html: string, d: DiscoveredEvent): ExternalEventInput {
  const lines = htmlToLines(html);

  const ogTitle = metaContent(html, "og:title");
  const title = cleanText((ogTitle ?? "").replace(/\s*-\s*Duoticket\s*$/i, ""), 200);
  if (title.length < 3) throw new Error("Título não encontrado.");

  const [dateLine] = valueAfter(lines, /^DATA$/i);
  const dm = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateLine ?? "");
  if (!dm) throw new Error("Data não encontrada.");
  const localDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
  const check = new Date(`${localDate}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== localDate) throw new Error("Data inválida.");

  // Horário só se a página trouxer um rótulo explícito com HH:MM (hoje a Duoticket não traz).
  const [timeLine] = valueAfter(lines, /^(HOR[ÁA]RIO|IN[ÍI]CIO|ABERTURA)$/i);
  const tm = /^(\d{1,2})[:h](\d{2})/i.exec(timeLine ?? "");
  const localTime = tm && Number(tm[1]) < 24 && Number(tm[2]) < 60 ? `${tm[1].padStart(2, "0")}:${tm[2]}` : null;

  const [venueLine, placeLine] = valueAfter(lines, /^LOCAL$/i, 2);
  let venueName: string | null = venueLine ? cleanText(venueLine, 200) : null;
  let cityName: string | null = null;
  let state: string | null = null;
  const pm = /^(.+?)\s*\|\s*(.+)$/.exec(placeLine ?? "");
  if (pm) {
    cityName = cleanText(pm[1], 120) || null;
    const st = cleanText(pm[2], 40);
    state = STATE_BY_NAME.get(normalize(st)) ?? (/^[A-Z]{2}$/.test(st) ? st : null);
  } else if (venueLine && /\|/.test(venueLine)) {
    // Sem nome de local: a primeira linha já é "Cidade | Estado".
    const only = /^(.+?)\s*\|\s*(.+)$/.exec(venueLine)!;
    venueName = null;
    cityName = cleanText(only[1], 120) || null;
    state = STATE_BY_NAME.get(normalize(only[2])) ?? null;
  }

  // Cancelamento só quando a página diz explicitamente.
  const head = lines.slice(0, 80).join(" ");
  const cancelled = /\bevento\s+cancelado\b/i.test(head);

  return {
    sourceEventId: d.sourceEventId,
    sourceUrl: d.url,
    title,
    localDate,
    localTime,
    venueName,
    cityName,
    state,
    categoryName: null,
    price: { status: "UNKNOWN" },
    cancelled,
  };
}

export const duoticketAdapter: ExternalSourceAdapter = {
  key: "duoticket",
  allowedHosts: [HOST, `www.${HOST}`],
  async discover(fetcher, { maxEvents }) {
    const { html } = await fetcher.html(HOME);
    const all = parseDuoticketListing(html, Number.MAX_SAFE_INTEGER);
    const events = all.slice(0, maxEvents);
    return { events, pagesFetched: 1, complete: events.length === all.length };
  },
  parseEvent: parseDuoticketEvent,
};
