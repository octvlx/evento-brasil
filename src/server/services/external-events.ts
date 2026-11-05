import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ExternalEvent, ExternalEventReview, ExternalSourceStatus, Prisma } from "@/generated/prisma/client";
import { defaultTimezoneForUF, isUF } from "@/lib/br";
import { zonedDateKey, zonedLocalToUtc } from "@/lib/datetime";
import { findMunicipalityByName } from "@/lib/municipalities";
import { slugify } from "@/lib/utils";
import { audit } from "../audit";
import { type Actor, assertAdminPermission } from "../auth/permissions";
import type { Db, Tx } from "../db";
import { AppError } from "../errors";
import { adapterFor } from "../external/registry";
import { ExternalFetchError, safeFetchHtml } from "../external/safe-fetch";
import type { ExternalEventInput, ExternalSourceAdapter, Fetcher } from "../external/types";
import { importCoverImage, previewCover, storeUploadedCover } from "../external/cover";
import { resolveCityFromIbge } from "./cities";
import { publicExternalWhere } from "./external-visibility";
import { dateFilterRange, type DateFilter, type PriceFilter } from "./catalog";

// Descoberta de eventos externos: importação idempotente por fonte, revisão antes de
// publicar e páginas públicas que levam ao site original. Nada aqui passa por pedidos,
// estoque, ingressos, comissão ou razão financeiro (tabelas próprias).

export const ADMIN_RUN_MAX_EVENTS = 50;
export const CRON_RUN_MAX_EVENTS = 25;
/** Intervalo mínimo entre coletas automáticas da mesma fonte. */
export const CRON_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Pausa entre requisições à fonte (educação com o servidor de terceiros). */
export const POLITE_DELAY_MS = 1_200;
const STALE_RUN_MS = 30 * 60 * 1000;
const MAX_LOGGED_ERRORS = 30;

const inputSchema = z.object({
  sourceEventId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  sourceUrl: z.string().url().max(500),
  title: z.string().trim().min(3).max(200),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  localTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  venueName: z.string().trim().max(200).nullable(),
  cityName: z.string().trim().max(120).nullable(),
  state: z.string().nullable(),
  categoryName: z.string().trim().max(80).nullable(),
  price: z.discriminatedUnion("status", [
    z.object({ status: z.literal("UNKNOWN") }),
    z.object({ status: z.literal("FREE") }),
    z.object({ status: z.literal("PAID"), minPriceCents: z.number().int().positive().max(100_000_00).nullable() }),
  ]),
  cancelled: z.boolean(),
});

/** Valida e normaliza o que o adaptador extraiu. Erro = evento ignorado e registrado. */
export function normalizeExternalInput(raw: ExternalEventInput, adapter: ExternalSourceAdapter, now = new Date()) {
  const v = inputSchema.parse(raw);
  const url = new URL(v.sourceUrl);
  if (url.protocol !== "https:" || !adapter.allowedHosts.includes(url.hostname.toLowerCase())) throw new Error("URL de origem fora da fonte autorizada.");
  const state = v.state && isUF(v.state) ? v.state : null;
  const timezone = state ? defaultTimezoneForUF(state) : "America/Sao_Paulo";
  const startsAt = zonedLocalToUtc(`${v.localDate}T${v.localTime ?? "00:00"}`, timezone);
  // Datas absurdas (erro de digitação na fonte, parser confuso) não entram.
  const year = Number(v.localDate.slice(0, 4));
  if (year < now.getUTCFullYear() - 1 || year > now.getUTCFullYear() + 3) throw new Error("Data fora do intervalo aceito.");
  return {
    sourceEventId: v.sourceEventId,
    sourceUrl: url.toString(),
    title: v.title,
    startsAt,
    hasTime: v.localTime !== null,
    timezone,
    venueName: v.venueName || null,
    cityName: v.cityName || null,
    state,
    categoryName: v.categoryName || null,
    priceStatus: v.price.status,
    minPriceCents: v.price.status === "PAID" ? v.price.minPriceCents : v.price.status === "FREE" ? 0 : null,
    cancelled: v.cancelled,
  };
}
type Normalized = ReturnType<typeof normalizeExternalInput>;

function contentHash(n: Normalized) {
  const { sourceEventId, sourceUrl, title, startsAt, hasTime, timezone, venueName, cityName, state, categoryName, priceStatus, minPriceCents, cancelled } = n;
  return createHash("sha256")
    .update(JSON.stringify([sourceEventId, sourceUrl, title, startsAt.toISOString(), hasTime, timezone, venueName, cityName, state, categoryName, priceStatus, minPriceCents, cancelled]))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Possíveis duplicados: mesma data local, mesma cidade e títulos muito parecidos.
// Só sinaliza para revisão; nunca une eventos.
// ---------------------------------------------------------------------------

const STOP = new Set(["de", "da", "do", "das", "dos", "e", "em", "no", "na", "com", "the", "a", "o", "os", "as", "festa", "show", "evento"]);
function tokens(title: string) {
  return new Set(
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}
export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
const SIMILAR = 0.6;

async function findPossibleDuplicate(tx: Tx, e: Pick<ExternalEvent, "id" | "sourceId" | "title" | "startsAt" | "timezone" | "cityName" | "state" | "cityId">): Promise<string | null> {
  const day = zonedDateKey(e.startsAt, e.timezone);
  const from = new Date(e.startsAt.getTime() - 36 * 3600_000);
  const to = new Date(e.startsAt.getTime() + 36 * 3600_000);
  const sameCity = (c: { cityName: string | null; state: string | null }) =>
    !!e.cityName && !!c.cityName && c.state === e.state && slugify(c.cityName) === slugify(e.cityName);
  const others = await tx.externalEvent.findMany({
    where: { id: { not: e.id }, sourceId: { not: e.sourceId }, startsAt: { gte: from, lte: to } },
    select: { slug: true, title: true, startsAt: true, timezone: true, cityName: true, state: true },
    take: 200,
  });
  for (const o of others) {
    if (zonedDateKey(o.startsAt, o.timezone) === day && sameCity(o) && titleSimilarity(o.title, e.title) >= SIMILAR) return `externo:${o.slug}`;
  }
  if (e.cityId) {
    const natives = await tx.event.findMany({
      where: { startsAt: { gte: from, lte: to }, OR: [{ cityId: e.cityId }, { venue: { cityId: e.cityId } }] },
      select: { slug: true, title: true, startsAt: true, timezone: true },
      take: 200,
    });
    for (const n of natives) {
      if (zonedDateKey(n.startsAt, n.timezone) === day && titleSimilarity(n.title, e.title) >= SIMILAR) return `nativo:${n.slug}`;
    }
  }
  return null;
}

async function cityIdFor(tx: Tx, n: Normalized): Promise<string | null> {
  if (!n.cityName || !n.state) return null;
  const m = findMunicipalityByName(n.cityName, n.state);
  if (!m) return null;
  return (await resolveCityFromIbge(tx, m.id, m.uf)).id;
}

// ---------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------

export interface ImportDeps {
  /** Busca com as proteções de safe-fetch; injetável nos testes (amostras locais). */
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

export interface ImportLimits {
  maxPages: number;
  maxEvents: number;
}

export type ImportSummary = {
  runId: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  pagesFetched: number;
  eventsSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  markedMissing: number;
};

function defaultFetcher(adapter: ExternalSourceAdapter): Fetcher {
  return { html: (url) => safeFetchHtml(url, { allowedHosts: adapter.allowedHosts, ...adapter.fetchOptions }) };
}

function errorMessage(e: unknown) {
  if (e instanceof z.ZodError) return `Dados inválidos: ${e.issues.map((i) => i.path.join(".")).join(", ")}`.slice(0, 300);
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

/**
 * Importa até `maxEvents` eventos de uma fonte ATIVA. Idempotente: chave (fonte, id na fonte)
 * e URL única; evento igual só renova `lastSeenAt`. Falhas de um evento não param a coleta;
 * falha da fonte não apaga nada. Evento novo entra em revisão.
 */
export async function runExternalImport(db: Db, sourceKey: string, limits: ImportLimits, trigger: "ADMIN" | "CRON", triggeredById: string | null, deps: ImportDeps = {}): Promise<ImportSummary> {
  const source = await db.externalSource.findUnique({ where: { key: sourceKey } });
  if (!source) throw new AppError("NOT_FOUND", "Fonte não encontrada.");
  if (source.status !== "ACTIVE") throw new AppError("INVALID_STATE", source.status === "PAUSED" ? "A fonte está pausada." : "A fonte depende de autorização e não tem coleta.");
  const adapter = adapterFor(source.key);
  if (!adapter) throw new AppError("INVALID_STATE", "Não há adaptador de coleta para esta fonte.");

  const now = deps.now ?? new Date();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetcher = deps.fetcher ?? defaultFetcher(adapter);
  const maxEvents = Math.max(1, Math.min(limits.maxEvents, ADMIN_RUN_MAX_EVENTS));
  const maxPages = Math.max(1, Math.min(limits.maxPages, 5));

  // Execução travada por fonte: uma "RUNNING" recente impede outra simultânea.
  await db.externalImportRun.updateMany({ where: { sourceId: source.id, status: "RUNNING", startedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } }, data: { status: "FAILED", finishedAt: now } });
  const busy = await db.externalImportRun.count({ where: { sourceId: source.id, status: "RUNNING" } });
  if (busy) throw new AppError("CONFLICT", "Já existe uma importação em andamento para esta fonte.");
  const run = await db.externalImportRun.create({ data: { sourceId: source.id, trigger, triggeredById } });

  const s = { pagesFetched: 0, eventsSeen: 0, created: 0, updated: 0, unchanged: 0, failed: 0, markedMissing: 0 };
  const errors: { url: string; error: string }[] = [];
  const logError = (url: string, e: unknown) => {
    s.failed++;
    if (errors.length < MAX_LOGGED_ERRORS) errors.push({ url: url.slice(0, 300), error: errorMessage(e) });
  };

  let status: ImportSummary["status"] = "SUCCEEDED";
  try {
    const listing = await adapter.discover(fetcher, { maxPages, maxEvents });
    s.pagesFetched += listing.pagesFetched;
    for (const [i, d] of listing.events.entries()) {
      if (i > 0) await sleep(POLITE_DELAY_MS);
      try {
        const page = await fetcher.html(d.url);
        s.pagesFetched++;
        const n = normalizeExternalInput(adapter.parseEvent(page.html, d), adapter, now);
        s.eventsSeen++;
        const result = await upsertExternalEvent(db, source.id, source.key, n, now);
        s[result]++;
      } catch (e) {
        logError(d.url, e);
      }
    }
    // Ausência só conta com a listagem inteira lida e sem falhas: listagem parcial não diz nada.
    if (listing.complete && s.failed === 0) {
      const seenIds = listing.events.map((e) => e.sourceEventId);
      const missing = await db.externalEvent.updateMany({
        where: { sourceId: source.id, sourceEventId: { notIn: seenIds }, sourceStatus: "ACTIVE", startsAt: { gt: now } },
        data: { sourceStatus: "MISSING" },
      });
      s.markedMissing = missing.count;
    }
    if (s.failed) status = s.eventsSeen ? "PARTIAL" : "FAILED";
  } catch (e) {
    // Falha da listagem (fonte fora do ar, bloqueio): nada é apagado nem marcado.
    status = "FAILED";
    logError(e instanceof ExternalFetchError ? source.homeUrl : "(listagem)", e);
  }

  await db.externalImportRun.update({
    where: { id: run.id },
    data: { status, finishedAt: new Date(), pagesFetched: s.pagesFetched, eventsSeen: s.eventsSeen, created: s.created, updated: s.updated, unchanged: s.unchanged, failed: s.failed, errors },
  });
  await db.externalSource.update({ where: { id: source.id }, data: { lastRunAt: now } });
  return { runId: run.id, status, ...s };
}

async function upsertExternalEvent(db: Db, sourceId: string, sourceKey: string, n: Normalized, now: Date): Promise<"created" | "updated" | "unchanged"> {
  const hash = contentHash(n);
  return db.$transaction(async (tx) => {
    const existing =
      (await tx.externalEvent.findUnique({ where: { sourceId_sourceEventId: { sourceId, sourceEventId: n.sourceEventId } } })) ??
      (await tx.externalEvent.findUnique({ where: { sourceUrl: n.sourceUrl } }));
    if (existing && existing.sourceId !== sourceId) throw new Error("URL já importada por outra fonte.");
    const sourceStatus = n.cancelled ? "CANCELLED" : "ACTIVE";
    if (existing && existing.contentHash === hash) {
      await tx.externalEvent.update({ where: { id: existing.id }, data: { lastSeenAt: now, ...(existing.sourceStatus === "MISSING" ? { sourceStatus } : {}) } });
      return "unchanged";
    }
    const cityId = await cityIdFor(tx, n);
    const data = {
      sourceEventId: n.sourceEventId,
      sourceUrl: n.sourceUrl,
      title: n.title,
      startsAt: n.startsAt,
      hasTime: n.hasTime,
      timezone: n.timezone,
      venueName: n.venueName,
      cityName: n.cityName,
      state: n.state,
      cityId,
      categoryName: n.categoryName,
      priceStatus: n.priceStatus,
      minPriceCents: n.minPriceCents,
      sourceStatus,
      contentHash: hash,
      lastSeenAt: now,
      lastChangedAt: now,
    } satisfies Partial<Prisma.ExternalEventUncheckedCreateInput>;
    const saved = existing
      ? await tx.externalEvent.update({ where: { id: existing.id }, data })
      : await tx.externalEvent.create({ data: { ...data, sourceId, slug: externalSlug(n.title, sourceKey, n.sourceEventId), firstSeenAt: now } });
    const dup = await findPossibleDuplicate(tx, saved);
    if (dup !== saved.possibleDuplicateOf) await tx.externalEvent.update({ where: { id: saved.id }, data: { possibleDuplicateOf: dup } });
    return existing ? "updated" : "created";
  });
}

export function externalSlug(title: string, sourceKey: string, sourceEventId: string) {
  const base = slugify(title).slice(0, 100).replace(/-+$/, "") || "evento";
  return `${base}-${sourceKey}-${sourceEventId}`.slice(0, 160);
}

/** Cron: coleta limitada das fontes ativas, no máximo a cada CRON_INTERVAL_MS por fonte. */
export async function runExternalSyncIfDue(db: Db, deps: ImportDeps = {}) {
  const now = deps.now ?? new Date();
  const due = await db.externalSource.findMany({
    where: { status: "ACTIVE", OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - CRON_INTERVAL_MS) } }] },
  });
  const results: Record<string, ImportSummary["status"] | "skipped"> = {};
  for (const source of due) {
    if (!adapterFor(source.key)) {
      results[source.key] = "skipped";
      continue;
    }
    try {
      results[source.key] = (await runExternalImport(db, source.key, { maxPages: 1, maxEvents: CRON_RUN_MAX_EVENTS }, "CRON", null, deps)).status;
    } catch (e) {
      if (e instanceof AppError && e.code === "CONFLICT") results[source.key] = "skipped";
      else throw e;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Administração (permissão de moderação de eventos)
// ---------------------------------------------------------------------------

const PERM = "events:moderate" as const;

export async function adminListExternalSources(db: Db, admin: Actor) {
  assertAdminPermission(admin, PERM);
  const sources = await db.externalSource.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { events: true } } } });
  return sources.map((s) => ({ ...s, hasAdapter: !!adapterFor(s.key) }));
}

export async function adminSetSourceStatus(db: Db, admin: Actor, sourceId: string, status: Extract<ExternalSourceStatus, "ACTIVE" | "PAUSED">) {
  assertAdminPermission(admin, PERM);
  if (status !== "ACTIVE" && status !== "PAUSED") throw new AppError("VALIDATION", "Situação inválida.");
  const source = await db.externalSource.findUnique({ where: { id: sourceId } });
  if (!source) throw new AppError("NOT_FOUND", "Fonte não encontrada.");
  if (source.status === "NEEDS_AUTHORIZATION") throw new AppError("INVALID_STATE", "Esta fonte depende de autorização (API, feed ou acordo) e não pode ser ativada.");
  if (status === "ACTIVE" && !adapterFor(source.key)) throw new AppError("INVALID_STATE", "Não há adaptador de coleta para esta fonte.");
  if (source.status === status) return source;
  const updated = await db.externalSource.update({ where: { id: sourceId }, data: { status } });
  await audit(db, { actorUserId: admin.id, action: status === "ACTIVE" ? "external_source.activated" : "external_source.paused", entityType: "ExternalSource", entityId: sourceId, metadata: { key: source.key } });
  return updated;
}

export async function adminRunExternalImport(db: Db, admin: Actor, sourceId: string, maxEvents: number, deps: ImportDeps = {}) {
  assertAdminPermission(admin, PERM);
  const source = await db.externalSource.findUnique({ where: { id: sourceId }, select: { key: true } });
  if (!source) throw new AppError("NOT_FOUND", "Fonte não encontrada.");
  const limit = Math.max(1, Math.min(Math.floor(maxEvents) || 1, ADMIN_RUN_MAX_EVENTS));
  const summary = await runExternalImport(db, source.key, { maxPages: 1, maxEvents: limit }, "ADMIN", admin.id, deps);
  await audit(db, { actorUserId: admin.id, action: "external_import.run", entityType: "ExternalSource", entityId: sourceId, metadata: { key: source.key, maxEvents: limit, ...summary } });
  return summary;
}

export async function adminListImportRuns(db: Db, admin: Actor, take = 15) {
  assertAdminPermission(admin, PERM);
  return db.externalImportRun.findMany({ orderBy: { startedAt: "desc" }, take, include: { source: { select: { name: true } } } });
}

export async function adminListExternalEvents(db: Db, admin: Actor, review: ExternalEventReview, take = 100) {
  assertAdminPermission(admin, PERM);
  return db.externalEvent.findMany({
    where: { review },
    orderBy: [{ startsAt: "asc" }],
    take,
    include: { source: { select: { name: true } } },
  });
}

const REVIEW_ACTION: Record<ExternalEventReview, string> = {
  PUBLISHED: "external_event.published",
  HIDDEN: "external_event.hidden",
  PENDING_REVIEW: "external_event.returned_to_review",
};

export async function adminReviewExternalEvent(db: Db, admin: Actor, eventId: string, review: ExternalEventReview) {
  assertAdminPermission(admin, PERM);
  if (!Object.hasOwn(REVIEW_ACTION, review)) throw new AppError("VALIDATION", "Situação inválida.");
  const event = await db.externalEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError("NOT_FOUND", "Evento externo não encontrado.");
  if (event.review === review) return event;
  const updated = await db.externalEvent.update({
    where: { id: eventId },
    // Sair de "publicado" tira o destaque: republicar não volta a destacar sem querer.
    data: { review, reviewedById: admin.id, publishedAt: review === "PUBLISHED" ? (event.publishedAt ?? new Date()) : event.publishedAt, ...(review !== "PUBLISHED" ? { isFeatured: false } : {}) },
  });
  await audit(db, { actorUserId: admin.id, action: REVIEW_ACTION[review], entityType: "ExternalEvent", entityId: eventId, metadata: { from: event.review, to: review } });
  return updated;
}

export async function adminGetExternalEvent(db: Db, admin: Actor, eventId: string) {
  assertAdminPermission(admin, PERM);
  const event = await db.externalEvent.findUnique({ where: { id: eventId }, include: { source: { select: { name: true, key: true, status: true } }, city: { select: { name: true, state: true, slug: true } } } });
  if (!event) throw new AppError("NOT_FOUND", "Evento externo não encontrado.");
  return event;
}

/** Destaque: mesma permissão do destaque de eventos nativos; destacar exige evento publicado. */
export async function adminSetExternalFeatured(db: Db, admin: Actor, eventId: string, featured: boolean) {
  assertAdminPermission(admin, PERM);
  const event = await db.externalEvent.findUnique({ where: { id: eventId }, select: { review: true, isFeatured: true } });
  if (!event) throw new AppError("NOT_FOUND", "Evento externo não encontrado.");
  if (featured && event.review !== "PUBLISHED") throw new AppError("INVALID_STATE", "Publique o evento antes de destacá-lo.");
  if (event.isFeatured === featured) return;
  await db.externalEvent.update({ where: { id: eventId }, data: { isFeatured: featured } });
  await audit(db, { actorUserId: admin.id, action: "external_event.featured", entityType: "ExternalEvent", entityId: eventId, metadata: { featured } });
}

/**
 * Cadastro manual pelo link da página do evento numa fonte autorizada (com adaptador):
 * lê a página com as proteções da coleta, extrai os dados factuais e cria (ou atualiza)
 * o evento em revisão. Funciona com a fonte pausada (ação explícita do admin), nunca
 * numa fonte que depende de autorização.
 */
export async function adminImportExternalEventByUrl(db: Db, admin: Actor, rawUrl: string, deps: ImportDeps = {}) {
  assertAdminPermission(admin, PERM);
  let url: URL;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new AppError("VALIDATION", "Cole o link completo da página do evento (https://…).");
  }
  const sources = await db.externalSource.findMany({ where: { status: { not: "NEEDS_AUTHORIZATION" } } });
  const match = sources.map((src) => ({ src, adapter: adapterFor(src.key) })).find(({ adapter }) => adapter?.allowedHosts.includes(url.hostname.toLowerCase()));
  if (!match?.adapter) {
    const names = sources.filter((src) => adapterFor(src.key)).map((src) => src.name).join(", ");
    throw new AppError("VALIDATION", `Esse site não é uma fonte autorizada. Fontes com cadastro por link: ${names || "nenhuma"}.`);
  }
  const { src: source, adapter } = match;
  const id = /\/evento\/(\d{1,9})\//.exec(url.pathname)?.[1];
  if (url.protocol !== "https:" || !id) throw new AppError("VALIDATION", "O link não é de uma página de evento dessa fonte.");
  const fetcher = deps.fetcher ?? defaultFetcher(adapter);
  const now = deps.now ?? new Date();
  let n: Normalized;
  try {
    const page = await fetcher.html(url.toString());
    n = normalizeExternalInput(adapter.parseEvent(page.html, { sourceEventId: id, url: url.toString() }), adapter, now);
  } catch (e) {
    throw new AppError("VALIDATION", `Não foi possível ler o evento: ${errorMessage(e)}`);
  }
  const result = await upsertExternalEvent(db, source.id, source.key, n, now);
  const event = await db.externalEvent.findUniqueOrThrow({ where: { sourceId_sourceEventId: { sourceId: source.id, sourceEventId: n.sourceEventId } } });
  await audit(db, { actorUserId: admin.id, action: "external_event.imported_by_url", entityType: "ExternalEvent", entityId: event.id, metadata: { source: source.key, result } });
  return { id: event.id, result };
}

type CoverDeps = Parameters<typeof previewCover>[2];

/** Prévia da capa (URL direta ou página): nada é gravado aqui. */
export async function adminPreviewExternalCover(db: Db, admin: Actor, eventId: string, url: string, deps?: CoverDeps) {
  assertAdminPermission(admin, PERM);
  const event = await db.externalEvent.findUnique({ where: { id: eventId }, select: { title: true } });
  if (!event) throw new AppError("NOT_FOUND", "Evento externo não encontrado.");
  if (!String(url ?? "").trim()) throw new AppError("VALIDATION", "Cole a URL da imagem ou o link da página do evento.");
  return previewCover(String(url), event.title, deps);
}

/** Confirma a capa: baixa de novo (validando), copia para o armazenamento e grava a URL própria. */
export async function adminSetExternalCoverFromUrl(db: Db, admin: Actor, eventId: string, imageUrl: string, deps?: CoverDeps) {
  assertAdminPermission(admin, PERM);
  const event = await db.externalEvent.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) throw new AppError("NOT_FOUND", "Evento externo não encontrado.");
  const stored = await importCoverImage(String(imageUrl ?? ""), deps);
  await db.externalEvent.update({ where: { id: eventId }, data: { coverImageUrl: stored.url } });
  await audit(db, { actorUserId: admin.id, action: "external_event.cover_imported", entityType: "ExternalEvent", entityId: eventId, metadata: { from: String(imageUrl).slice(0, 300), width: stored.width, height: stored.height } });
  return stored;
}

export async function adminUploadExternalCover(db: Db, admin: Actor, eventId: string, file: File) {
  assertAdminPermission(admin, PERM);
  const event = await db.externalEvent.findUnique({ where: { id: eventId }, select: { id: true } });
  if (!event) throw new AppError("NOT_FOUND", "Evento externo não encontrado.");
  const url = await storeUploadedCover(file);
  await db.externalEvent.update({ where: { id: eventId }, data: { coverImageUrl: url } });
  await audit(db, { actorUserId: admin.id, action: "external_event.cover_uploaded", entityType: "ExternalEvent", entityId: eventId });
  return url;
}

export async function adminRemoveExternalCover(db: Db, admin: Actor, eventId: string) {
  assertAdminPermission(admin, PERM);
  await db.externalEvent.update({ where: { id: eventId }, data: { coverImageUrl: null } });
  await audit(db, { actorUserId: admin.id, action: "external_event.cover_removed", entityType: "ExternalEvent", entityId: eventId });
}

/**
 * Exclusão do registro (é só a nossa cópia do anúncio; não há pedido nem dinheiro ligado).
 * Some da busca, das cidades e dos destaques na hora. Uma nova coleta da fonte pode trazê-lo
 * de volta em revisão; para não voltar, prefira "Ocultar".
 */
export async function adminDeleteExternalEvent(db: Db, admin: Actor, eventId: string) {
  assertAdminPermission(admin, PERM);
  const event = await db.externalEvent.findUnique({ where: { id: eventId }, select: { id: true, sourceUrl: true } });
  if (!event) throw new AppError("NOT_FOUND", "Evento externo não encontrado.");
  await db.externalEvent.delete({ where: { id: eventId } });
  await audit(db, { actorUserId: admin.id, action: "external_event.deleted", entityType: "ExternalEvent", entityId: eventId, metadata: { sourceUrl: event.sourceUrl } });
}

// ---------------------------------------------------------------------------
// Público
// ---------------------------------------------------------------------------

export { publicExternalWhere };

export interface ExternalListFilter {
  cityId?: string;
  q?: string;
  /** Filtros da busca. Eventos externos não têm categoria: com categoria, nenhum aparece. */
  date?: DateFilter;
  price?: PriceFilter;
  categorySlug?: string;
  featuredOnly?: boolean;
  take?: number;
}

/** Faixa de preço → condição. Preço desconhecido nunca entra num filtro de preço. */
function priceWhere(price: PriceFilter): Prisma.ExternalEventWhereInput {
  if (price === "gratis") return { priceStatus: "FREE" };
  const range = price === "ate-50" ? { lte: 5000 } : price === "50-150" ? { gte: 5000, lte: 15000 } : { gte: 15000 };
  return { priceStatus: "PAID", minPriceCents: range };
}

export async function listPublicExternalEvents(db: Db, filter: ExternalListFilter = {}, now = new Date()) {
  if (filter.categorySlug) return [];
  const q = filter.q?.trim().slice(0, 80);
  const and: Prisma.ExternalEventWhereInput[] = [publicExternalWhere(now)];
  if (filter.cityId) and.push({ cityId: filter.cityId });
  if (filter.featuredOnly) and.push({ isFeatured: true });
  if (q) and.push({ OR: [{ title: { contains: q, mode: "insensitive" } }, { venueName: { contains: q, mode: "insensitive" } }, { cityName: { contains: q, mode: "insensitive" } }] });
  if (filter.date) {
    const range = dateFilterRange(filter.date, now);
    // Sem horário de término na fonte: conta pelo início dentro da janela.
    and.push({ startsAt: { gte: range.from, lt: range.to } });
  }
  if (filter.price) and.push(priceWhere(filter.price));
  return db.externalEvent.findMany({
    where: { AND: and },
    orderBy: { startsAt: "asc" },
    take: Math.min(filter.take ?? 8, 24),
    include: { source: { select: { name: true } } },
  });
}

/** Destaques externos públicos (home e cidade), mesma regra de visibilidade. */
export async function featuredExternalEvents(db: Db, opts: { cityId?: string; limit?: number } = {}, now = new Date()) {
  return listPublicExternalEvents(db, { cityId: opts.cityId, featuredOnly: true, take: opts.limit ?? 6 }, now);
}

/** Eventos externos públicos cujo título combina com o texto (sugestões da busca). */
export async function suggestExternalEvents(db: Db, text: string, opts: { cityId?: string; take?: number } = {}, now = new Date()) {
  const q = text.trim().slice(0, 80);
  if (q.length < 2) return [];
  return db.externalEvent.findMany({
    where: { AND: [publicExternalWhere(now), { title: { contains: q, mode: "insensitive" } }, ...(opts.cityId ? [{ cityId: opts.cityId }] : [])] },
    orderBy: { startsAt: "asc" },
    take: opts.take ?? 4,
    select: { id: true, title: true, venueName: true, cityId: true, cityName: true, state: true },
  });
}

/** Página pública: só publicado. Cancelado/ausente/encerrado ainda abre, com o aviso certo. */
export async function getPublicExternalEvent(db: Db, slug: string) {
  return db.externalEvent.findFirst({ where: { slug, review: "PUBLISHED", source: { status: { not: "NEEDS_AUTHORIZATION" } } }, include: { source: { select: { name: true, homeUrl: true, key: true } } } });
}

/** Conteúdo suficiente para indexar: publicado, ativo, futuro, com cidade e UF. */
export function isIndexableExternal(e: Pick<ExternalEvent, "review" | "sourceStatus" | "startsAt" | "cityName" | "state">, now = new Date()) {
  return e.review === "PUBLISHED" && e.sourceStatus === "ACTIVE" && e.startsAt.getTime() > now.getTime() - 24 * 3600_000 && !!e.cityName && !!e.state;
}

export async function listExternalSitemapEntries(db: Db, now = new Date()) {
  const rows = await db.externalEvent.findMany({ where: { ...publicExternalWhere(now), cityName: { not: null }, state: { not: null } }, select: { slug: true, updatedAt: true }, orderBy: { startsAt: "asc" }, take: 5_000 });
  return rows;
}

/** Contadores agregados (sem dado pessoal), no padrão de TrackingLink.clicks. */
export async function recordExternalView(db: Db, id: string) {
  await db.externalEvent.updateMany({ where: { id, review: "PUBLISHED" }, data: { viewCount: { increment: 1 } } });
}

/**
 * Clique de saída: conta e devolve a URL original, só se for HTTPS e de um host autorizado
 * da fonte. Não é compra: o resultado da venda acontece fora da plataforma.
 */
export async function recordExternalOutboundClick(db: Db, slug: string): Promise<string | null> {
  const event = await db.externalEvent.findFirst({ where: { slug, review: "PUBLISHED" }, select: { id: true, sourceUrl: true, source: { select: { key: true } } } });
  if (!event) return null;
  const adapter = adapterFor(event.source.key);
  let url: URL;
  try {
    url = new URL(event.sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !adapter || !adapter.allowedHosts.includes(url.hostname.toLowerCase())) return null;
  await db.externalEvent.update({ where: { id: event.id }, data: { outboundClicks: { increment: 1 } } });
  return url.toString();
}
