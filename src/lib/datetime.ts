// Datas armazenadas em UTC; exibidas e editadas no fuso do evento.

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Diferença (ms) entre o relógio local do fuso e UTC naquele instante. */
function offsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** "2026-11-20T20:00" no fuso `timeZone` → instante UTC. */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new RangeError(`Data/hora local inválida: ${local}`);
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Duas iterações resolvem mudanças de offset (horário de verão em outros fusos).
  let guess = naive - offsetMs(new Date(naive), timeZone);
  guess = naive - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

/** Instante UTC → "YYYY-MM-DDTHH:mm" no fuso informado (para <input type="datetime-local">). */
export function utcToZonedLocalInput(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Data civil (YYYY-MM-DD) de um instante no fuso. */
export function zonedDateKey(date: Date, timeZone: string): string {
  return utcToZonedLocalInput(date, timeZone).slice(0, 10);
}

export function formatEventDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Partes para o "canhoto" de data dos cards: dia, mês curto e dia da semana + hora, no fuso do evento. */
export function eventDateStub(date: Date, timeZone: string): { day: string; month: string; weekdayTime: string } {
  const get = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { timeZone, ...opts }).format(date);
  const clean = (s: string) => s.replace(/\./g, "");
  return {
    day: get({ day: "2-digit" }),
    month: clean(get({ month: "short" })).toUpperCase(),
    weekdayTime: `${clean(get({ weekday: "short" }))} · ${get({ hour: "2-digit", minute: "2-digit" })}`,
  };
}

export function formatDateLong(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatDateShort(date: Date, timeZone = "America/Sao_Paulo"): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

export function formatDateTimeShort(date: Date, timeZone = "America/Sao_Paulo"): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Abreviação do fuso (ex.: "BRT", "GMT-4") para deixar claro o horário local. */
export function timezoneLabel(date: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("pt-BR", { timeZone, timeZoneName: "short" }).formatToParts(date);
  return p.find((x) => x.type === "timeZoneName")?.value ?? timeZone;
}

/** Janela [início, fim) em UTC de uma data civil local, deslocada `days` dias. */
export function localDayRange(base: Date, timeZone: string, days = 0, span = 1): { from: Date; to: Date } {
  const key = zonedDateKey(new Date(base.getTime() + days * 86_400_000), timeZone);
  const from = zonedLocalToUtc(`${key}T00:00`, timeZone);
  const endKey = zonedDateKey(new Date(from.getTime() + span * 86_400_000 + 3_600_000), timeZone);
  return { from, to: zonedLocalToUtc(`${endKey}T00:00`, timeZone) };
}

/** Próximo fim de semana (sexta 18h → segunda 0h, horário local). Se já for fim de semana, o atual. */
export function weekendRange(now: Date, timeZone: string): { from: Date; to: Date } {
  const key = zonedDateKey(now, timeZone);
  const dow = new Date(`${key}T12:00:00Z`).getUTCDay(); // 0=dom … 6=sáb
  const toFriday = dow === 0 ? -2 : dow === 6 ? -1 : 5 - dow;
  const friday = localDayRange(now, timeZone, toFriday).from;
  const fridayKey = zonedDateKey(friday, timeZone);
  const from = new Date(Math.max(now.getTime(), zonedLocalToUtc(`${fridayKey}T18:00`, timeZone).getTime()));
  const to = localDayRange(friday, timeZone, 3).from;
  return { from, to };
}
