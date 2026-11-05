// Eventos externos (descoberta): importação idempotente, atualização, preço ausente ×
// gratuito, fusos, falhas da fonte, ausência sem apagar, duplicados para revisão,
// permissões, publicação e separação total do checkout/financeiro. Só amostras locais.
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminRole } from "@/generated/prisma/client";
import { duoticketAdapter } from "@/server/external/adapters/duoticket";
import {
  adminReviewExternalEvent,
  adminRunExternalImport,
  adminSetSourceStatus,
  getPublicExternalEvent,
  isIndexableExternal,
  listExternalSitemapEntries,
  listPublicExternalEvents,
  normalizeExternalInput,
  recordExternalOutboundClick,
  runExternalImport,
  runExternalSyncIfDue,
  titleSimilarity,
} from "@/server/services/external-events";
import { adminStats } from "@/server/services/reports";
import { searchEvents } from "@/server/services/catalog";
import { db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";
import { duoEventHtml, duoListingHtml, fakeFetcher } from "../support/external-fixtures";

beforeEach(resetDb);

const HOME = "https://duoticket.com.br/";
const url = (id: string) => `https://duoticket.com.br/evento/${id}/Evento-${id}`;
const NOW = new Date("2026-11-05T12:00:00Z");
const noSleep = async () => undefined;
const LIMITS = { maxPages: 1, maxEvents: 50 };

async function sources(status: "ACTIVE" | "PAUSED" = "ACTIVE") {
  await db.externalSource.createMany({
    data: [
      { id: "extsrc_duoticket", key: "duoticket", name: "Duoticket", homeUrl: HOME, status },
      { id: "extsrc_sympla", key: "sympla", name: "Sympla", homeUrl: "https://www.sympla.com.br/", status: "NEEDS_AUTHORIZATION" },
    ],
  });
}

function site(events: Record<string, Parameters<typeof duoEventHtml>[0]>, listingIds = Object.keys(events)) {
  const pages: Record<string, string> = { [HOME]: duoListingHtml(listingIds.map((id) => ({ id, slug: `Evento-${id}` }))) };
  for (const [id, e] of Object.entries(events)) pages[url(id)] = duoEventHtml(e);
  return pages;
}

const run = (pages: Record<string, string>, limits = LIMITS, now = NOW) => runExternalImport(db, "duoticket", limits, "CRON", null, { fetcher: fakeFetcher(pages), sleep: noSleep, now });

async function adminWith(roles: AdminRole[]) {
  const u = await makeUser({ admin: true });
  return db.user.update({ where: { id: u.id }, data: { adminRoles: roles } });
}

describe("importação", () => {
  it("cria em revisão, reimporta sem duplicar e atualiza só o que mudou", async () => {
    await sources();
    const pages = site({ "101": { title: "Baile da Cidade", date: "20/12/2026" }, "102": { title: "Sarau Noturno", date: "21/12/2026", place: "Manaus | Amazonas" } });
    expect(await run(pages)).toMatchObject({ status: "SUCCEEDED", created: 2, updated: 0, unchanged: 0, failed: 0 });
    const first = await db.externalEvent.findMany({ orderBy: { sourceEventId: "asc" } });
    expect(first.map((e) => e.review)).toEqual(["PENDING_REVIEW", "PENDING_REVIEW"]);

    expect(await run(pages, LIMITS, new Date(NOW.getTime() + 3600_000))).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(await db.externalEvent.count()).toBe(2);

    // Mudança de data e local na fonte: atualiza o mesmo registro.
    const changed = { ...pages, [url("101")]: duoEventHtml({ title: "Baile da Cidade", date: "27/12/2026", venue: "Novo Salão" }) };
    expect(await run(changed, LIMITS, new Date(NOW.getTime() + 7200_000))).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    const updated = await db.externalEvent.findFirstOrThrow({ where: { sourceEventId: "101" } });
    expect(updated).toMatchObject({ venueName: "Novo Salão", id: first[0].id });
    expect(updated.lastChangedAt.getTime()).toBeGreaterThan(first[0].lastChangedAt.getTime());
  });

  it("sem horário: meia-noite no fuso da UF; preço ausente fica desconhecido (nunca gratuito)", async () => {
    await sources();
    await run(site({ "201": { title: "Show em SP", date: "20/12/2026" }, "202": { title: "Show em Manaus", date: "20/12/2026", place: "Manaus | Amazonas", time: "21:00" } }));
    const sp = await db.externalEvent.findFirstOrThrow({ where: { sourceEventId: "201" } });
    expect(sp).toMatchObject({ hasTime: false, timezone: "America/Sao_Paulo", priceStatus: "UNKNOWN", minPriceCents: null, state: "SP", cityName: "Campinas" });
    expect(sp.startsAt.toISOString()).toBe("2026-12-20T03:00:00.000Z");
    const am = await db.externalEvent.findFirstOrThrow({ where: { sourceEventId: "202" } });
    expect(am).toMatchObject({ hasTime: true, timezone: "America/Manaus" });
    expect(am.startsAt.toISOString()).toBe("2026-12-21T01:00:00.000Z");
    // Município confirmado pelo IBGE vira cidade do catálogo.
    expect((await db.city.findUniqueOrThrow({ where: { id: sp.cityId! } })).name).toBe("Campinas");
  });

  it("o banco recusa preço incoerente: desconhecido com valor ou gratuito com valor", async () => {
    await sources();
    await run(site({ "301": { title: "Teste de Preço", date: "20/12/2026" } }));
    const e = await db.externalEvent.findFirstOrThrow();
    await expect(db.externalEvent.update({ where: { id: e.id }, data: { minPriceCents: 0 } })).rejects.toThrow();
    await expect(db.externalEvent.update({ where: { id: e.id }, data: { priceStatus: "FREE", minPriceCents: 500 } })).rejects.toThrow();
    await expect(db.externalEvent.update({ where: { id: e.id }, data: { priceStatus: "FREE", minPriceCents: 0 } })).resolves.toMatchObject({ priceStatus: "FREE" });
  });

  it("falha da fonte não apaga nem marca nada; falha de uma página não para as outras", async () => {
    await sources();
    await run(site({ "401": { title: "Primeiro Show", date: "20/12/2026" }, "402": { title: "Segundo Show", date: "21/12/2026" } }));
    const down = await run({}, LIMITS, new Date(NOW.getTime() + 3600_000));
    expect(down).toMatchObject({ status: "FAILED", failed: 1 });
    expect(await db.externalEvent.count({ where: { sourceStatus: "ACTIVE" } })).toBe(2);

    const pages = site({ "401": { title: "Primeiro Show", date: "20/12/2026" } }, ["401", "402"]); // página do 402 fora do ar
    const partial = await run(pages, LIMITS, new Date(NOW.getTime() + 7200_000));
    expect(partial).toMatchObject({ status: "PARTIAL", unchanged: 1, failed: 1, markedMissing: 0 });
    const runRow = await db.externalImportRun.findUniqueOrThrow({ where: { id: partial.runId } });
    expect(JSON.stringify(runRow.errors)).toContain("evento/402");
    expect(await db.externalEvent.count({ where: { sourceStatus: "ACTIVE" } })).toBe(2);
  });

  it("ausência só marca com a listagem completa; listagem limitada não marca; nunca apaga", async () => {
    await sources();
    await run(site({ "501": { title: "Fica", date: "20/12/2026" }, "502": { title: "Some", date: "21/12/2026" } }));
    // Listagem limitada a 1: não sabemos do resto.
    await run(site({ "501": { title: "Fica", date: "20/12/2026" }, "502": { title: "Some", date: "21/12/2026" } }), { maxPages: 1, maxEvents: 1 });
    expect(await db.externalEvent.count({ where: { sourceStatus: "MISSING" } })).toBe(0);
    // Listagem completa sem o 502.
    expect(await run(site({ "501": { title: "Fica", date: "20/12/2026" } }))).toMatchObject({ markedMissing: 1 });
    expect(await db.externalEvent.findFirstOrThrow({ where: { sourceEventId: "502" } })).toMatchObject({ sourceStatus: "MISSING" });
    expect(await db.externalEvent.count()).toBe(2);
    // Voltou a aparecer: volta a ativo.
    await run(site({ "501": { title: "Fica", date: "20/12/2026" }, "502": { title: "Some", date: "21/12/2026" } }));
    expect(await db.externalEvent.findFirstOrThrow({ where: { sourceEventId: "502" } })).toMatchObject({ sourceStatus: "ACTIVE" });
  });

  it("cancelamento explícito na fonte vira CANCELLED e sai das listagens públicas", async () => {
    await sources();
    await run(site({ "601": { title: "Vai Cancelar", date: "20/12/2026" } }));
    const e = await db.externalEvent.findFirstOrThrow();
    await db.externalEvent.update({ where: { id: e.id }, data: { review: "PUBLISHED" } });
    expect(await listPublicExternalEvents(db, {}, NOW)).toHaveLength(1);
    await run(site({ "601": { title: "Vai Cancelar", date: "20/12/2026", cancelled: true } }));
    expect(await db.externalEvent.findFirstOrThrow()).toMatchObject({ sourceStatus: "CANCELLED" });
    expect(await listPublicExternalEvents(db, {}, NOW)).toHaveLength(0);
  });

  it("conteúdo malicioso e URL fora da fonte não entram", async () => {
    await sources();
    await run(site({ "701": { title: "&lt;script&gt;alert(1)&lt;/script&gt;Festa Segura", date: "20/12/2026" } }));
    expect((await db.externalEvent.findFirstOrThrow()).title).toBe("alert(1) Festa Segura");
    const raw = { ...duoticketAdapter.parseEvent(duoEventHtml({ title: "Golpe", date: "20/12/2026" }), { sourceEventId: "702", url: url("702") }), sourceUrl: "https://evil.example/evento/702" };
    expect(() => normalizeExternalInput(raw, duoticketAdapter, NOW)).toThrow(/fora da fonte/);
    expect(() => normalizeExternalInput({ ...raw, sourceUrl: url("702"), localDate: "2099-01-01" }, duoticketAdapter, NOW)).toThrow(/intervalo/);
  });

  it("possível duplicado entre plataformas é sinalizado para revisão, sem unir", async () => {
    await sources();
    // Evento da outra fonte, mesmo dia e cidade, título parecido.
    await db.externalEvent.create({
      data: {
        sourceId: "extsrc_sympla",
        sourceEventId: "s1",
        sourceUrl: "https://www.sympla.com.br/evento/s1",
        slug: "festival-de-jazz-sympla-s1",
        title: "Festival de Jazz Campinas",
        startsAt: new Date("2026-12-20T03:00:00Z"),
        timezone: "America/Sao_Paulo",
        cityName: "Campinas",
        state: "SP",
        contentHash: "x",
      },
    });
    await run(site({ "801": { title: "Festival de Jazz Campinas 2026", date: "20/12/2026" }, "802": { title: "Outra Coisa", date: "20/12/2026" } }));
    expect(await db.externalEvent.findFirstOrThrow({ where: { sourceEventId: "801" } })).toMatchObject({ possibleDuplicateOf: "externo:festival-de-jazz-sympla-s1" });
    expect(await db.externalEvent.findFirstOrThrow({ where: { sourceEventId: "802" } })).toMatchObject({ possibleDuplicateOf: null });
    expect(await db.externalEvent.count()).toBe(3);
    expect(titleSimilarity("Festival de Jazz", "Festival Jazz")).toBe(1);
    expect(titleSimilarity("Rock na Praça", "Samba na Praça")).toBeLessThan(0.6);
  });

  it("fonte pausada ou sem autorização não coleta; importação simultânea é recusada", async () => {
    await sources("PAUSED");
    await expect(run(site({}))).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(runExternalImport(db, "sympla", LIMITS, "CRON", null, { fetcher: fakeFetcher({}), sleep: noSleep })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await db.externalSource.update({ where: { key: "duoticket" }, data: { status: "ACTIVE" } });
    await db.externalImportRun.create({ data: { sourceId: "extsrc_duoticket", trigger: "ADMIN", startedAt: NOW } });
    await expect(run(site({}))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cron: coleta fonte ativa vencida e respeita o intervalo", async () => {
    await sources();
    const pages = site({ "901": { title: "Cron Show", date: "20/12/2026" } });
    expect(await runExternalSyncIfDue(db, { fetcher: fakeFetcher(pages), sleep: noSleep, now: NOW })).toEqual({ duoticket: "SUCCEEDED" });
    expect(await runExternalSyncIfDue(db, { fetcher: fakeFetcher(pages), sleep: noSleep, now: new Date(NOW.getTime() + 3600_000) })).toEqual({});
    expect(await db.externalEvent.count()).toBe(1);
  });
});

describe("administração", () => {
  it("só quem modera eventos importa, ativa e revisa; tudo fica na auditoria", async () => {
    await sources("PAUSED");
    const support = await adminWith(["SUPPORT"]);
    const moderator = await adminWith(["MODERATION"]);
    const customer = await makeUser();
    await expect(adminSetSourceStatus(db, support, "extsrc_duoticket", "ACTIVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminSetSourceStatus(db, customer, "extsrc_duoticket", "ACTIVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminSetSourceStatus(db, moderator, "extsrc_sympla", "ACTIVE")).rejects.toMatchObject({ code: "INVALID_STATE" });
    await adminSetSourceStatus(db, moderator, "extsrc_duoticket", "ACTIVE");

    const pages = site({ "1001": { title: "Revisar Antes", date: "20/12/2026" } });
    await expect(adminRunExternalImport(db, support, "extsrc_duoticket", 10, { fetcher: fakeFetcher(pages), sleep: noSleep, now: NOW })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await adminRunExternalImport(db, moderator, "extsrc_duoticket", 999, { fetcher: fakeFetcher(pages), sleep: noSleep, now: NOW })).toMatchObject({ created: 1 });

    const e = await db.externalEvent.findFirstOrThrow();
    await expect(adminReviewExternalEvent(db, support, e.id, "PUBLISHED")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminReviewExternalEvent(db, moderator, e.id, "QUALQUER" as never)).rejects.toMatchObject({ code: "VALIDATION" });
    await adminReviewExternalEvent(db, moderator, e.id, "PUBLISHED");
    await adminReviewExternalEvent(db, moderator, e.id, "HIDDEN");
    const actions = (await db.auditLog.findMany({ where: { actorUserId: moderator.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["external_source.activated", "external_import.run", "external_event.published", "external_event.hidden"]);
  });
});

describe("público e separação do checkout", () => {
  it("só publicado aparece; saída conta clique e vai só para a URL original; nada entra no financeiro", async () => {
    await sources();
    const owner = await makeUser();
    await makeEvent(await makeOrg(owner));
    const admin = await makeUser({ admin: true });
    const statsBefore = await adminStats(db, admin);
    const nativeBefore = await searchEvents(db, {});

    await run(site({ "1101": { title: "Publicar Este", date: "20/12/2026" }, "1102": { title: "Ocultar Este", date: "20/12/2026" } }));
    const [pub, hid] = await db.externalEvent.findMany({ orderBy: { sourceEventId: "asc" } });
    expect(await getPublicExternalEvent(db, pub.slug)).toBeNull();
    expect(await recordExternalOutboundClick(db, pub.slug)).toBeNull();

    await adminReviewExternalEvent(db, admin, pub.id, "PUBLISHED");
    await adminReviewExternalEvent(db, admin, hid.id, "HIDDEN");
    expect((await listPublicExternalEvents(db, {}, NOW)).map((e) => e.slug)).toEqual([pub.slug]);
    expect((await listPublicExternalEvents(db, { q: "publicar" }, NOW)).length).toBe(1);
    expect(isIndexableExternal((await getPublicExternalEvent(db, pub.slug))!, NOW)).toBe(true);
    expect((await listExternalSitemapEntries(db, NOW)).map((e) => e.slug)).toEqual([pub.slug]);

    expect(await recordExternalOutboundClick(db, pub.slug)).toBe(url("1101"));
    expect(await db.externalEvent.findUniqueOrThrow({ where: { id: pub.id } })).toMatchObject({ outboundClicks: 1 });
    // URL adulterada no banco para outro host: a saída é recusada.
    await db.externalEvent.update({ where: { id: pub.id }, data: { sourceUrl: "https://evil.example/x" } });
    expect(await recordExternalOutboundClick(db, pub.slug)).toBeNull();

    // Fonte que perdeu a autorização some do público.
    await db.externalSource.update({ where: { key: "duoticket" }, data: { status: "NEEDS_AUTHORIZATION" } });
    expect(await listPublicExternalEvents(db, {}, NOW)).toHaveLength(0);

    // Eventos externos não são eventos nativos: nada muda no catálogo nativo nem nos números financeiros.
    expect((await searchEvents(db, {})).total).toBe(nativeBefore.total);
    const statsAfter = await adminStats(db, admin);
    expect(statsAfter.balances).toEqual(statsBefore.balances);
    expect(statsAfter.orders).toEqual(statsBefore.orders);
    expect(await db.order.count()).toBe(0);
    expect(await db.financialLedgerEntry.count()).toBe(0);
  });
});
