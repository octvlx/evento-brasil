// Eventos externos (descoberta): importação idempotente, atualização, preço ausente ×
// gratuito, fusos, falhas da fonte, ausência sem apagar, duplicados para revisão,
// permissões, publicação e separação total do checkout/financeiro. Só amostras locais.
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminRole } from "@/generated/prisma/client";
import { duoticketAdapter } from "@/server/external/adapters/duoticket";
import {
  adminAutoCoverExternalEvent,
  adminFeatureExternalEvents,
  BULK_FEATURE_MAX,
  adminExternalCityOptions,
  adminListExternalEvents,
  adminPublishExternalEvents,
  BULK_PUBLISH_MAX,
  adminExternalCounts,
  pagePublicExternalEvents,
  adminDeleteExternalEvent,
  adminImportExternalEventByUrl,
  adminPreviewExternalCover,
  adminRemoveExternalCover,
  adminReviewExternalEvent,
  adminSetExternalCoverFromUrl,
  adminSetExternalFeatured,
  adminUploadExternalCover,
  featuredExternalEvents,
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
import { getPublicCity, listCities, searchEvents } from "@/server/services/catalog";
import { suggestSearch } from "@/server/services/search";
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

describe("busca, sugestões e cidades", () => {
  it("cidade só com evento externo publicado aparece nas sugestões e na busca; some quando ele sai do ar", async () => {
    await sources();
    const admin = await makeUser({ admin: true });
    await run(site({ "1201": { title: "Baile Lotado Externo", date: "20/12/2026", place: "Campinas | São Paulo" } }));
    const e = await db.externalEvent.findFirstOrThrow();
    // Em revisão: a cidade ainda não é pública.
    expect((await listCities(db, { now: NOW })).map((c) => c.slug)).not.toContain("campinas-sp");
    expect(await suggestSearch(db, "campin", NOW)).toEqual([]);

    await adminReviewExternalEvent(db, admin, e.id, "PUBLISHED");
    expect((await listCities(db, { now: NOW })).map((c) => c.slug)).toContain("campinas-sp");
    expect(await getPublicCity(db, "campinas-sp", NOW)).not.toBeNull();
    const groups = await suggestSearch(db, "campin", NOW);
    expect(groups.find((g) => g.kind === "city")?.items).toEqual([expect.objectContaining({ citySlug: "campinas-sp" })]);
    // Termo + cidade: combinação sugerida; e o evento externo no grupo de eventos.
    const combo = await suggestSearch(db, "baile em camp", NOW);
    expect(combo.find((g) => g.kind === "combo")?.items[0]).toMatchObject({ citySlug: "campinas-sp" });
    const ev = (await suggestSearch(db, "baile lotado", NOW)).find((g) => g.kind === "event");
    expect(ev?.items[0]).toMatchObject({ label: "Baile Lotado Externo", detail: expect.stringContaining("Evento externo") });
    expect((await listPublicExternalEvents(db, { cityId: e.cityId! }, NOW)).map((x) => x.id)).toEqual([e.id]);

    // Ocultar tira a cidade das sugestões; excluir também.
    await adminReviewExternalEvent(db, admin, e.id, "HIDDEN");
    expect((await listCities(db, { now: NOW })).map((c) => c.slug)).not.toContain("campinas-sp");
    await adminReviewExternalEvent(db, admin, e.id, "PUBLISHED");
    await adminDeleteExternalEvent(db, admin, e.id);
    expect(await db.externalEvent.count()).toBe(0);
    expect(await getPublicCity(db, "campinas-sp", NOW)).toBeNull();
  });

  it("filtros da busca valem para os externos: data, preço e categoria", async () => {
    await sources();
    const admin = await makeUser({ admin: true });
    await run(site({ "1301": { title: "Show Data Perto", date: "07/11/2026" }, "1302": { title: "Show Data Longe", date: "20/12/2026" } }));
    for (const e of await db.externalEvent.findMany()) await adminReviewExternalEvent(db, admin, e.id, "PUBLISHED");
    const titles = async (f: Parameters<typeof listPublicExternalEvents>[1]) => (await listPublicExternalEvents(db, f, NOW)).map((e) => e.title).sort();
    expect(await titles({})).toEqual(["Show Data Longe", "Show Data Perto"]);
    // 05/11/2026 é quinta: o fim de semana é 07–08/11.
    expect(await titles({ date: "fim-de-semana" })).toEqual(["Show Data Perto"]);
    expect(await titles({ date: "hoje" })).toEqual([]);
    // Preço não informado nunca entra num filtro de preço; com preço informado, entra.
    expect(await titles({ price: "gratis" })).toEqual([]);
    await db.externalEvent.updateMany({ where: { title: "Show Data Longe" }, data: { priceStatus: "FREE" } });
    expect(await titles({ price: "gratis" })).toEqual(["Show Data Longe"]);
    // A fonte não informa categoria: com categoria escolhida, nenhum externo aparece.
    expect(await titles({ categorySlug: "shows" })).toEqual([]);
  });

  it("cidade antiga com o nome escrito diferente (caixa, acentos, espaços) é reaproveitada; UF diferente não", async () => {
    await sources();
    const legacy = await db.city.create({ data: { name: "CAMPINAS ", state: "SP", slug: "campinas-legado", timezone: "America/Sao_Paulo" } });
    const otherUf = await db.city.create({ data: { name: "Campinas", state: "RJ", slug: "campinas-rj-legado", timezone: "America/Sao_Paulo" } });
    await run(site({ "1401": { title: "Sem Cidade Duplicada", date: "20/12/2026", place: "campinas | São Paulo" } }));
    const e = await db.externalEvent.findFirstOrThrow();
    expect(e.cityId).toBe(legacy.id);
    expect(await db.city.count({ where: { state: "SP" } })).toBe(1);
    expect(await db.city.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ ibgeCode: "3509502" });
    expect(await db.city.findUniqueOrThrow({ where: { id: otherUf.id } })).toMatchObject({ ibgeCode: null });
  });
});

describe("destaque", () => {
  it("só quem modera destaca; exige publicado; despublicar tira o destaque", async () => {
    await sources();
    const moderator = await adminWith(["MODERATION"]);
    const support = await adminWith(["SUPPORT"]);
    await run(site({ "1501": { title: "Destaque Externo", date: "20/12/2026" } }));
    const e = await db.externalEvent.findFirstOrThrow();
    await expect(adminSetExternalFeatured(db, moderator, e.id, true)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await adminReviewExternalEvent(db, moderator, e.id, "PUBLISHED");
    await expect(adminSetExternalFeatured(db, support, e.id, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await adminSetExternalFeatured(db, moderator, e.id, true);
    const featured = await featuredExternalEvents(db, {}, NOW);
    expect(featured.map((x) => x.id)).toEqual([e.id]);
    expect(await featuredExternalEvents(db, { cityId: e.cityId! }, NOW)).toHaveLength(1);

    await adminReviewExternalEvent(db, moderator, e.id, "HIDDEN");
    expect(await db.externalEvent.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({ isFeatured: false });
    expect(await featuredExternalEvents(db, {}, NOW)).toHaveLength(0);
    await adminReviewExternalEvent(db, moderator, e.id, "PUBLISHED");
    expect(await featuredExternalEvents(db, {}, NOW)).toHaveLength(0);

    await adminSetExternalFeatured(db, moderator, e.id, true);
    await adminSetExternalFeatured(db, moderator, e.id, false);
    expect(await featuredExternalEvents(db, {}, NOW)).toHaveLength(0);
    const meta = (await db.auditLog.findMany({ where: { actorUserId: moderator.id, action: "external_event.featured" }, orderBy: { createdAt: "asc" } })).map((a) => a.metadata);
    expect(meta).toEqual([{ featured: true }, { featured: true }, { featured: false }]);
  });
});

describe("capa e cadastro por link", () => {
  function png(width: number, height: number) {
    const b = new Uint8Array(64);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const dv = new DataView(b.buffer);
    dv.setUint32(16, width);
    dv.setUint32(20, height);
    return b;
  }
  const deps = (routes: Record<string, () => Response>) => ({
    resolveHost: async () => ["104.18.10.10"],
    sleep: noSleep,
    fetchImpl: (async (u: string | URL) => routes[String(u)]?.() ?? new Response("", { status: 404 })) as unknown as typeof fetch,
  });

  it("prévia não grava; confirmar copia para o armazenamento; upload e remoção; tudo auditado", async () => {
    await sources();
    const admin = await adminWith(["MODERATION"]);
    const support = await adminWith(["SUPPORT"]);
    await run(site({ "1601": { title: "Capa Externa", date: "20/12/2026" } }));
    const e = await db.externalEvent.findFirstOrThrow();
    const IMG = "https://imagedelivery.net/acc/abc/capa";
    const d = deps({ [IMG]: () => new Response(png(800, 400), { headers: { "content-type": "image/png" } }) });

    await expect(adminPreviewExternalCover(db, support, e.id, IMG, d)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const preview = await adminPreviewExternalCover(db, admin, e.id, IMG, d);
    expect(preview).toMatchObject({ kind: "direct", candidates: [{ url: IMG, width: 800, height: 400 }] });
    expect((await db.externalEvent.findUniqueOrThrow({ where: { id: e.id } })).coverImageUrl).toBeNull();

    const stored = await adminSetExternalCoverFromUrl(db, admin, e.id, IMG, d);
    // URL própria da plataforma: a página não carrega a imagem do site de terceiros.
    expect(stored.url).toMatch(/^\/uploads\/events\/external\/.+\.png$/);
    expect((await db.externalEvent.findUniqueOrThrow({ where: { id: e.id } })).coverImageUrl).toBe(stored.url);
    await expect(adminSetExternalCoverFromUrl(db, admin, e.id, "https://127.0.0.1/x.png", d)).rejects.toMatchObject({ code: "VALIDATION" });

    const uploaded = await adminUploadExternalCover(db, admin, e.id, new File([png(1200, 600)], "capa.png", { type: "image/png" }));
    expect(uploaded).toMatch(/^\/uploads\/events\/external\//);
    await expect(adminUploadExternalCover(db, admin, e.id, new File(["<svg/>"], "x.png", { type: "image/png" }))).rejects.toMatchObject({ code: "VALIDATION" });
    await adminRemoveExternalCover(db, admin, e.id);
    expect((await db.externalEvent.findUniqueOrThrow({ where: { id: e.id } })).coverImageUrl).toBeNull();
    const actions = (await db.auditLog.findMany({ where: { actorUserId: admin.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["external_event.cover_imported", "external_event.cover_uploaded", "external_event.cover_removed"]);
  });

  it("cadastro por link: só fonte autorizada com página de evento; cria em revisão e não duplica", async () => {
    await sources("PAUSED");
    const admin = await adminWith(["MODERATION"]);
    const link = url("1701");
    const fetcher = fakeFetcher({ [link]: duoEventHtml({ title: "Por Link", date: "20/12/2026" }) });
    await expect(adminImportExternalEventByUrl(db, admin, "https://evil.example/evento/1/x", { fetcher, now: NOW })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(adminImportExternalEventByUrl(db, admin, "https://duoticket.com.br/ajuda", { fetcher, now: NOW })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(adminImportExternalEventByUrl(db, admin, "isso não é link", { fetcher, now: NOW })).rejects.toMatchObject({ code: "VALIDATION" });
    const first = await adminImportExternalEventByUrl(db, admin, link, { fetcher, now: NOW });
    const again = await adminImportExternalEventByUrl(db, admin, link, { fetcher, now: NOW });
    expect(again.id).toBe(first.id);
    expect(await db.externalEvent.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ title: "Por Link", review: "PENDING_REVIEW" });
  });
});

describe("capa automática ao publicar", () => {
  function png(width: number, height: number) {
    const b = new Uint8Array(64);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const dv = new DataView(b.buffer);
    dv.setUint32(16, width);
    dv.setUint32(20, height);
    return b;
  }
  const PERFIL = "https://imagedelivery.net/acc/p1/perfil";
  const CAPA = "https://imagedelivery.net/acc/c1/capa";
  const page = `<html><head><meta property="og:image" content="${PERFIL}"></head><body><img data-src="${CAPA}" alt="Auto Capa"></body></html>`;
  const deps = (routes: Record<string, () => Response>) => ({
    resolveHost: async () => ["104.18.10.10"],
    sleep: noSleep,
    fetchImpl: (async (u: string | URL) => routes[String(u)]?.() ?? new Response("", { status: 404 })) as unknown as typeof fetch,
  });

  it("usa a imagem 300×300 da página original; não troca capa existente; falha não quebra", async () => {
    await sources();
    const admin = await adminWith(["MODERATION"]);
    await run(site({ "1801": { title: "Auto Capa", date: "20/12/2026" } }));
    const e = await db.externalEvent.findFirstOrThrow();
    const ok = deps({
      [e.sourceUrl]: () => new Response(page, { headers: { "content-type": "text/html" } }),
      [CAPA]: () => new Response(png(800, 400), { headers: { "content-type": "image/png" } }),
      [PERFIL]: () => new Response(png(300, 300), { headers: { "content-type": "image/png" } }),
    });
    expect(await adminAutoCoverExternalEvent(db, admin, e.id, ok)).toBe("set");
    const cover = (await db.externalEvent.findUniqueOrThrow({ where: { id: e.id } })).coverImageUrl;
    expect(cover).toMatch(/^\/uploads\/events\/external\//);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "external_event.cover_auto" } });
    expect(log.metadata).toMatchObject({ from: PERFIL, width: 300, height: 300 });

    expect(await adminAutoCoverExternalEvent(db, admin, e.id, ok)).toBe("kept");
    expect((await db.externalEvent.findUniqueOrThrow({ where: { id: e.id } })).coverImageUrl).toBe(cover);

    await db.externalEvent.update({ where: { id: e.id }, data: { coverImageUrl: null } });
    expect(await adminAutoCoverExternalEvent(db, admin, e.id, deps({}))).toBe("none");
    expect((await db.externalEvent.findUniqueOrThrow({ where: { id: e.id } })).coverImageUrl).toBeNull();
    await expect(adminAutoCoverExternalEvent(db, await adminWith(["SUPPORT"]), e.id, ok)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("eventos que já aconteceram", () => {
  it("Importar agora só traz eventos de hoje em diante; os passados são contados como ignorados", async () => {
    await sources();
    // NOW = 05/11/2026 12:00 UTC (manhã em Brasília).
    const res = await run(site({ "1901": { title: "Ontem", date: "04/11/2026" }, "1902": { title: "Hoje", date: "05/11/2026" }, "1903": { title: "Depois", date: "20/12/2026" } }));
    expect(res).toMatchObject({ created: 2, skippedPast: 1, failed: 0 });
    expect((await db.externalEvent.findMany({ orderBy: { title: "asc" } })).map((e) => e.title)).toEqual(["Depois", "Hoje"]);
    expect(await db.externalImportRun.findFirstOrThrow()).toMatchObject({ skippedPast: 1, created: 2 });

    const admin = await adminWith(["MODERATION"]);
    const link = url("1904");
    const fetcher = fakeFetcher({ [link]: duoEventHtml({ title: "Passado Por Link", date: "01/11/2026" }) });
    await expect(adminImportExternalEventByUrl(db, admin, link, { fetcher, now: NOW })).rejects.toThrow(/já aconteceu/);
  });

  it("destaque some sozinho quando o dia do evento passa", async () => {
    await sources();
    const admin = await adminWith(["MODERATION"]);
    await run(site({ "2001": { title: "Destaque Do Dia", date: "05/11/2026" }, "2002": { title: "Destaque Futuro", date: "20/12/2026" } }));
    for (const e of await db.externalEvent.findMany()) {
      await adminReviewExternalEvent(db, admin, e.id, "PUBLISHED");
      await adminSetExternalFeatured(db, admin, e.id, true);
    }
    const titles = async (now: Date) => (await featuredExternalEvents(db, { limit: 99 }, now)).map((e) => e.title);
    // No dia: os dois, em ordem cronológica.
    expect(await titles(NOW)).toEqual(["Destaque Do Dia", "Destaque Futuro"]);
    expect(await titles(new Date("2026-11-06T02:30:00Z"))).toEqual(["Destaque Do Dia", "Destaque Futuro"]); // 23:30 em Brasília
    // Dia seguinte em Brasília: o do dia anterior sai do destaque.
    expect(await titles(new Date("2026-11-06T03:30:00Z"))).toEqual(["Destaque Futuro"]);
  });
});

describe("paginação da busca e números do admin", () => {
  it("todos os externos são alcançáveis página a página, em ordem de data, sem repetir", async () => {
    await sources();
    const admin = await adminWith(["MODERATION"]);
    const events: Record<string, Parameters<typeof duoEventHtml>[0]> = {};
    for (let i = 1; i <= 26; i++) events[String(2100 + i)] = { title: `Paginado ${i}`, date: `${String(i).padStart(2, "0")}/12/2026` };
    await run(site(events), { maxPages: 1, maxEvents: 50 });
    for (const e of await db.externalEvent.findMany()) await adminReviewExternalEvent(db, admin, e.id, "PUBLISHED");

    const p1 = await pagePublicExternalEvents(db, {}, 1, NOW);
    expect(p1).toMatchObject({ total: 26, page: 1, pageCount: 3 });
    expect(p1.events).toHaveLength(12);
    const p3 = await pagePublicExternalEvents(db, {}, 3, NOW);
    expect(p3.events.map((e) => e.title)).toEqual(["Paginado 25", "Paginado 26"]);
    // Página fora do intervalo cai na última; lixo cai na primeira.
    expect((await pagePublicExternalEvents(db, {}, 99, NOW)).page).toBe(3);
    expect((await pagePublicExternalEvents(db, {}, Number("abc"), NOW)).page).toBe(1);
    const all = [...p1.events, ...(await pagePublicExternalEvents(db, {}, 2, NOW)).events, ...p3.events].map((e) => e.title);
    expect(new Set(all).size).toBe(26);
    expect(all.slice(0, 3)).toEqual(["Paginado 1", "Paginado 2", "Paginado 3"]);
    // Filtros continuam valendo (categoria: nenhum).
    expect((await pagePublicExternalEvents(db, { categorySlug: "shows" }, 1, NOW)).total).toBe(0);
    expect((await pagePublicExternalEvents(db, { q: "Paginado 2" }, 1, NOW)).total).toBe(8); // 2, 20–26

    const [a, b] = await db.externalEvent.findMany({ take: 2, orderBy: { startsAt: "asc" } });
    await adminSetExternalFeatured(db, admin, a.id, true);
    await adminSetExternalFeatured(db, admin, b.id, true);
    await adminReviewExternalEvent(db, admin, (await db.externalEvent.findFirstOrThrow({ where: { title: "Paginado 26" } })).id, "HIDDEN");
    expect(await adminExternalCounts(db, admin, NOW)).toEqual({ published: 25, featured: 2, featuredVisible: 2, pending: 0, hidden: 1 });
    // Depois do dia do 1º destaque, ele continua marcado mas não aparece mais no destaque.
    expect(await adminExternalCounts(db, admin, new Date("2026-12-02T12:00:00Z"))).toMatchObject({ featured: 2, featuredVisible: 1 });
    await expect(adminExternalCounts(db, await adminWith(["SUPPORT"]), NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("filtros e publicação em lote no admin", () => {
  async function seedMany() {
    await sources();
    await run(
      site({
        "2201": { title: "Samba na Praça", date: "10/12/2026", place: "Campinas | São Paulo" },
        "2202": { title: "Samba de Roda", date: "20/12/2026", place: "Santos | São Paulo" },
        "2203": { title: "Rock no Parque", date: "15/12/2026", place: "Campinas | São Paulo" },
        "2204": { title: "Forró Pé de Serra", date: "05/01/2027", place: "Campinas | São Paulo" },
      }),
    );
    return Object.fromEntries((await db.externalEvent.findMany()).map((e) => [e.title, e]));
  }

  it("filtra por nome, cidade e período, com total e opções de cidade", async () => {
    const ev = await seedMany();
    const admin = await adminWith(["MODERATION"]);
    const titles = async (f: Parameters<typeof adminListExternalEvents>[4]) => (await adminListExternalEvents(db, admin, "PENDING_REVIEW", 500, f)).map((e) => e.title);
    expect(await titles({ q: "samba" })).toEqual(["Samba na Praça", "Samba de Roda"]);
    expect(await titles({ city: "SP:Campinas" })).toEqual(["Samba na Praça", "Rock no Parque", "Forró Pé de Serra"]);
    expect(await titles({ from: "2026-12-12", to: "2026-12-31" })).toEqual(["Rock no Parque", "Samba de Roda"]);
    expect(await titles({ to: "2026-12-10" })).toEqual(["Samba na Praça"]); // o dia "até" é incluído
    expect(await titles({ q: "samba", city: "SP:Campinas" })).toEqual(["Samba na Praça"]);
    // Valores inválidos são ignorados, sem erro.
    expect(await titles({ city: "x", from: "ontem" })).toHaveLength(4);
    const list = await adminListExternalEvents(db, admin, "PENDING_REVIEW", 2, {});
    expect(list).toHaveLength(2);
    expect(list.total).toBe(4);
    expect(await adminExternalCityOptions(db, admin, "PENDING_REVIEW")).toEqual([
      { value: "SP:Campinas", label: "Campinas – SP", count: 3 },
      { value: "SP:Santos", label: "Santos – SP", count: 1 },
    ]);
    // Situação também filtra: publicados não aparecem em revisão.
    await adminReviewExternalEvent(db, admin, ev["Rock no Parque"].id, "PUBLISHED");
    expect(await titles({ city: "SP:Campinas" })).toEqual(["Samba na Praça", "Forró Pé de Serra"]);
  });

  it("publica só os selecionados, pelo serviço de publicação; falhas e já publicados vêm por evento", async () => {
    const ev = await seedMany();
    const admin = await adminWith(["MODERATION"]);
    await adminReviewExternalEvent(db, admin, ev["Samba de Roda"].id, "PUBLISHED");
    const res = await adminPublishExternalEvents(db, admin, [ev["Samba na Praça"].id, ev["Samba de Roda"].id, "naoexiste", ev["Samba na Praça"].id]);
    expect(res).toEqual([
      { id: ev["Samba na Praça"].id, title: "Samba na Praça", status: "published" },
      { id: ev["Samba de Roda"].id, title: "Samba de Roda", status: "already" },
      { id: "naoexiste", title: "(evento não encontrado)", status: "failed", error: "Evento externo não encontrado." },
    ]);
    // Os não selecionados continuam em revisão.
    const states = Object.fromEntries((await db.externalEvent.findMany()).map((e) => [e.title, e.review]));
    expect(states).toEqual({ "Samba na Praça": "PUBLISHED", "Samba de Roda": "PUBLISHED", "Rock no Parque": "PENDING_REVIEW", "Forró Pé de Serra": "PENDING_REVIEW" });
    // Mesma auditoria da publicação individual.
    expect(await db.auditLog.count({ where: { actorUserId: admin.id, action: "external_event.published" } })).toBe(2);
  });

  it("recusa sem permissão, sem seleção e acima do limite", async () => {
    const ev = await seedMany();
    const support = await adminWith(["SUPPORT"]);
    const admin = await adminWith(["MODERATION"]);
    await expect(adminPublishExternalEvents(db, support, [ev["Samba na Praça"].id])).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminPublishExternalEvents(db, admin, [])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(adminPublishExternalEvents(db, admin, "tudo")).rejects.toMatchObject({ code: "VALIDATION" });
    const many = Array.from({ length: BULK_PUBLISH_MAX + 1 }, (_, i) => `id${i}`);
    await expect(adminPublishExternalEvents(db, admin, many)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.externalEvent.count({ where: { review: "PUBLISHED" } })).toBe(0);
    await expect(adminListExternalEvents(db, support, "PENDING_REVIEW")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("destaque em lote no admin", () => {
  it("destaca só os selecionados pelo serviço de destaque; já destacado não é regravado; despublicado falha", async () => {
    await sources();
    const admin = await adminWith(["MODERATION"]);
    await run(site({ "2301": { title: "Destaque A", date: "10/12/2026" }, "2302": { title: "Destaque B", date: "11/12/2026" }, "2303": { title: "Destaque C", date: "12/12/2026" }, "2304": { title: "Fora", date: "13/12/2026" } }));
    const ev = Object.fromEntries((await db.externalEvent.findMany()).map((e) => [e.title, e]));
    for (const t of ["Destaque A", "Destaque B", "Destaque C", "Fora"]) await adminReviewExternalEvent(db, admin, ev[t].id, "PUBLISHED");
    await adminSetExternalFeatured(db, admin, ev["Destaque B"].id, true);
    // Saiu de "publicado" depois de selecionado.
    await adminReviewExternalEvent(db, admin, ev["Destaque C"].id, "HIDDEN");
    const auditsBefore = await db.auditLog.count({ where: { action: "external_event.featured" } });

    const res = await adminFeatureExternalEvents(db, admin, [ev["Destaque A"].id, ev["Destaque B"].id, ev["Destaque C"].id, "sumiu", ev["Destaque A"].id]);
    expect(res).toEqual([
      { id: ev["Destaque A"].id, title: "Destaque A", status: "featured" },
      { id: ev["Destaque B"].id, title: "Destaque B", status: "already" },
      { id: ev["Destaque C"].id, title: "Destaque C", status: "failed", error: "Publique o evento antes de destacá-lo." },
      { id: "sumiu", title: "(evento não encontrado)", status: "failed", error: "Evento externo não encontrado." },
    ]);
    const featured = Object.fromEntries((await db.externalEvent.findMany()).map((e) => [e.title, e.isFeatured]));
    expect(featured).toEqual({ "Destaque A": true, "Destaque B": true, "Destaque C": false, Fora: false });
    // Uma auditoria nova só (A): o já destacado não gerou operação.
    expect(await db.auditLog.count({ where: { action: "external_event.featured" } })).toBe(auditsBefore + 1);
  });

  it("recusa sem permissão, sem seleção e acima do limite", async () => {
    await sources();
    const support = await adminWith(["SUPPORT"]);
    const admin = await adminWith(["MODERATION"]);
    await expect(adminFeatureExternalEvents(db, support, ["x"])).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminFeatureExternalEvents(db, admin, [])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(adminFeatureExternalEvents(db, admin, Array.from({ length: BULK_FEATURE_MAX + 1 }, (_, i) => `id${i}`))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

