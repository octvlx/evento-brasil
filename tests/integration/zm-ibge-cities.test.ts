// ZM — cidade do evento a partir da base local do IBGE: criada (ou reaproveitada)
// só ao salvar o evento, na transação dele; homônimos pelo código; concorrência
// sem duplicar; rollback sem cidade órfã; código/UF inválidos recusados; a
// atualização da base não toca na tabela City; páginas públicas só com eventos no ar.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { serializeDataset, updateMunicipalities } from "../../scripts/ibge-update";
import { allMunicipalities } from "@/lib/municipalities";
import { getPublicCity, listCities, listSitemapEntries } from "@/server/services/catalog";
import { cityFormValue } from "@/server/services/cities";
import { saveEventWizardStep, startEventDraft } from "@/server/services/event-wizard";
import { createEvent, updateEvent } from "@/server/services/events";
import { db, makeCategory, makeCity, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const SAO_PAULO = { cityIbgeCode: "3550308", cityUf: "SP" };
const CURITIBA = { cityIbgeCode: "4106902", cityUf: "PR" };
const BOM_JESUS_PI = { cityIbgeCode: "2201903", cityUf: "PI" };
const BOM_JESUS_RS = { cityIbgeCode: "4302303", cityUf: "RS" };

async function setup() {
  const [owner, category] = await Promise.all([makeUser(), makeCategory()]);
  const org = await makeOrg(owner);
  return { owner, org, category };
}

function eventInput(categoryId: string, city: { cityIbgeCode?: string; cityUf?: string; cityId?: string }, title = "Show da Cidade") {
  return {
    title,
    description: "Um show de teste com descrição longa o suficiente.",
    categoryId,
    locationType: "VENUE" as const,
    newVenue: { name: "Espaço Teste", addressLine: "Rua Exemplo, 100", ...city },
    timezone: "America/Sao_Paulo" as const,
    startsAtLocal: "2030-05-10T20:00",
    endsAtLocal: "2030-05-10T23:00",
    salesStartLocal: "2026-01-01T00:00",
    salesEndLocal: "2030-05-10T20:00",
    ageRestriction: 0,
    capacity: 100,
    refundPolicy: "Reembolso em até 7 dias após a compra.",
  };
}

const cityOf = (eventId: string) => db.event.findUniqueOrThrow({ where: { id: eventId }, include: { city: true, venue: { include: { city: true } } } });

describe("ZM — cidade criada ao salvar o evento", () => {
  it("cidade antiga sem código (seed) é reaproveitada e ganha o código; a próxima vem pelo código", async () => {
    const { owner, org, category } = await setup();
    const legacy = await makeCity(); // São Paulo – SP, sem ibgeCode
    expect(legacy.ibgeCode).toBeNull();
    const a = await createEvent(db, owner, org.id, eventInput(category.id, SAO_PAULO));
    const b = await createEvent(db, owner, org.id, eventInput(category.id, SAO_PAULO, "Outro show"));
    expect(a.cityId).toBe(legacy.id);
    expect(b.cityId).toBe(legacy.id);
    expect(await db.city.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ ibgeCode: "3550308", slug: "sao-paulo-sp", name: "São Paulo" });
    expect(await db.city.count()).toBe(1);
    expect((await cityOf(a.id)).venue?.cityId).toBe(legacy.id);
  });

  it("cidade nova é criada com nome, UF, código, slug e fuso da UF", async () => {
    const { owner, org, category } = await setup();
    const e = await createEvent(db, owner, org.id, eventInput(category.id, CURITIBA));
    const city = (await cityOf(e.id)).city!;
    expect(city).toMatchObject({ name: "Curitiba", state: "PR", ibgeCode: "4106902", slug: "curitiba-pr", timezone: "America/Sao_Paulo", isFeatured: false });
    expect(e.slug).toContain("curitiba");
  });

  it("homônimos (Bom Jesus – PI × Bom Jesus – RS) viram cidades diferentes", async () => {
    const { owner, org, category } = await setup();
    const pi = await createEvent(db, owner, org.id, eventInput(category.id, BOM_JESUS_PI));
    const rs = await createEvent(db, owner, org.id, eventInput(category.id, BOM_JESUS_RS));
    const [cpi, crs] = await Promise.all([cityOf(pi.id), cityOf(rs.id)]);
    expect(cpi.cityId).not.toBe(crs.cityId);
    expect(cpi.city).toMatchObject({ name: "Bom Jesus", state: "PI", ibgeCode: "2201903", slug: "bom-jesus-pi" });
    expect(crs.city).toMatchObject({ name: "Bom Jesus", state: "RS", ibgeCode: "4302303", slug: "bom-jesus-rs" });
  });

  it("pedidos simultâneos com a mesma cidade nova não duplicam nem falham", async () => {
    const { owner, org, category } = await setup();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => createEvent(db, owner, org.id, eventInput(category.id, CURITIBA, `Show ${i}`))));
    expect(new Set(results.map((e) => e.cityId)).size).toBe(1);
    expect(await db.city.count({ where: { ibgeCode: "4106902" } })).toBe(1);
    expect(await db.city.count()).toBe(1);
  });

  it("pedidos simultâneos adotando a mesma cidade antiga também não duplicam", async () => {
    const { owner, org, category } = await setup();
    const legacy = await makeCity();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => createEvent(db, owner, org.id, eventInput(category.id, SAO_PAULO, `Show ${i}`))));
    expect(results.every((e) => e.cityId === legacy.id)).toBe(true);
    expect(await db.city.count()).toBe(1);
  });

  it("evento que falha depois de resolver a cidade não deixa cidade órfã (rollback)", async () => {
    const { owner, org } = await setup();
    // Categoria inexistente: a FK do evento falha DEPOIS de a cidade e o local serem gravados na transação.
    await expect(createEvent(db, owner, org.id, eventInput("categoria-que-nao-existe", CURITIBA))).rejects.toThrow();
    expect(await db.city.count()).toBe(0);
    expect(await db.venue.count()).toBe(0);
    expect(await db.event.count()).toBe(0);
  });

  it("código inexistente, código de outra UF ou cidade faltando são recusados sem criar nada", async () => {
    const { owner, org, category } = await setup();
    await expect(createEvent(db, owner, org.id, eventInput(category.id, { cityIbgeCode: "9999999", cityUf: "SP" }))).rejects.toThrow("Município inválido");
    await expect(createEvent(db, owner, org.id, eventInput(category.id, { cityIbgeCode: "4106902", cityUf: "SC" }))).rejects.toThrow("Município inválido");
    await expect(createEvent(db, owner, org.id, eventInput(category.id, { cityIbgeCode: "123", cityUf: "PR" }))).rejects.toThrow("Selecione a cidade na lista");
    await expect(createEvent(db, owner, org.id, eventInput(category.id, { cityIbgeCode: "4106902", cityUf: "XX" }))).rejects.toThrow("Selecione a UF");
    await expect(createEvent(db, owner, org.id, eventInput(category.id, { cityUf: "PR" }))).rejects.toThrow("Selecione a cidade na lista");
    await expect(createEvent(db, owner, org.id, eventInput(category.id, {}))).rejects.toThrow("Selecione a UF");
    expect(await db.city.count()).toBe(0);
    expect(await db.event.count()).toBe(0);
  });

  it("cidade antiga com outro código IBGE no mesmo nome + UF é conflito, não sobrescrita", async () => {
    const { owner, org, category } = await setup();
    await db.city.create({ data: { slug: "curitiba-pr", name: "Curitiba", state: "PR", ibgeCode: "4100000", timezone: "America/Sao_Paulo" } });
    await expect(createEvent(db, owner, org.id, eventInput(category.id, CURITIBA))).rejects.toThrow("outro código IBGE");
    expect((await db.city.findFirstOrThrow()).ibgeCode).toBe("4100000");
  });

  it("slug já usado por outra cidade: desempata com o código, sem falhar", async () => {
    const { owner, org, category } = await setup();
    await db.city.create({ data: { slug: "curitiba-pr", name: "Curitiba (antiga)", state: "PR", timezone: "America/Sao_Paulo" } });
    const e = await createEvent(db, owner, org.id, eventInput(category.id, CURITIBA));
    expect((await cityOf(e.id)).city).toMatchObject({ name: "Curitiba", ibgeCode: "4106902", slug: "curitiba-pr-4106902" });
  });

  it("editar o evento para outra cidade cria/reaproveita a nova e não apaga a antiga", async () => {
    const { owner, org, category } = await setup();
    const e = await createEvent(db, owner, org.id, eventInput(category.id, CURITIBA));
    const curitiba = (await cityOf(e.id)).cityId!;
    await updateEvent(db, owner, e.id, { ...eventInput(category.id, BOM_JESUS_RS), newVenue: { name: "Outro Espaço", addressLine: "Rua B, 1", ...BOM_JESUS_RS } });
    const after = await cityOf(e.id);
    expect(after.city).toMatchObject({ ibgeCode: "4302303" });
    expect(await db.city.findUnique({ where: { id: curitiba } })).not.toBeNull();
    expect(await db.city.count()).toBe(2);
  });

  it("assistente (etapa 2): cidade criada ao salvar e reexibida no autocomplete", async () => {
    const { owner, org, category } = await setup();
    const { event } = await startEventDraft(db, owner, org.id, { draftKey: "chave-zm-assistente", title: "Rascunho na Serra", categoryId: category.id });
    const step2 = {
      timezone: "America/Sao_Paulo",
      startsAtLocal: "2030-06-01T20:00",
      endsAtLocal: "2030-06-01T23:00",
      locationType: "VENUE",
      venueMode: "new",
      newVenue: { name: "Casa da Serra", street: "Rua A", number: "10", complement: "", district: "", postalCode: "", ...BOM_JESUS_RS, cityName: "Bom Jesus" },
    };
    await expect(saveEventWizardStep(db, owner, event.id, 2, { ...step2, newVenue: { ...step2.newVenue, cityUf: "SC" } }, { complete: true })).rejects.toThrow("Município inválido");
    expect(await db.city.count()).toBe(0);
    await saveEventWizardStep(db, owner, event.id, 2, step2, { complete: true });
    // Autosave repetido: mesma cidade, mesmo local.
    await saveEventWizardStep(db, owner, event.id, 2, step2, { complete: false });
    const saved = await cityOf(event.id);
    expect(saved.city).toMatchObject({ name: "Bom Jesus", state: "RS", ibgeCode: "4302303" });
    expect(await db.city.count()).toBe(1);
    expect(await db.venue.count()).toBe(1);
    expect(cityFormValue(saved.city)).toEqual({ cityUf: "RS", cityIbgeCode: "4302303", cityName: "Bom Jesus" });
    // Cidade antiga sem código: o autocomplete acha pelo nome + UF.
    expect(cityFormValue({ name: "São Paulo", state: "SP", ibgeCode: null })).toEqual({ cityUf: "SP", cityIbgeCode: "3550308", cityName: "São Paulo" });
  });

  it("compatibilidade: `cityId` de cidade já cadastrada continua aceito", async () => {
    const { owner, org, category } = await setup();
    const city = await makeCity();
    const e = await createEvent(db, owner, org.id, eventInput(category.id, { cityId: city.id }));
    expect(e.cityId).toBe(city.id);
    await expect(createEvent(db, owner, org.id, eventInput(category.id, { cityId: "nao-existe" }))).rejects.toThrow("Cidade inválida");
  });
});

describe("ZM — páginas públicas só com cidades de eventos no ar", () => {
  it("cidade nova de rascunho não aparece; publicada aparece; encerrado/cancelado some", async () => {
    const { owner, org, category } = await setup();
    const e = await createEvent(db, owner, org.id, eventInput(category.id, CURITIBA));
    const city = (await cityOf(e.id)).city!;
    expect(await listCities(db)).toEqual([]);
    expect(await getPublicCity(db, city.slug)).toBeNull();
    expect((await listSitemapEntries(db)).cities).toEqual([]);

    await db.event.update({ where: { id: e.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    expect((await listCities(db)).map((c) => c.slug)).toEqual(["curitiba-pr"]);
    expect(await getPublicCity(db, "curitiba-pr")).toMatchObject({ id: city.id });

    await db.event.update({ where: { id: e.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    expect(await listCities(db)).toEqual([]);
    await db.event.update({ where: { id: e.id }, data: { status: "PUBLISHED" } });
    expect(await listCities(db, { now: new Date("2031-01-01T00:00:00Z") })).toEqual([]); // depois do fim
  });

  it("organização não aprovada não expõe a cidade", async () => {
    const { owner, category } = await setup();
    const pending = await makeOrg(owner, { status: "PENDING_REVIEW" });
    const e = await createEvent(db, owner, pending.id, eventInput(category.id, CURITIBA));
    await db.event.update({ where: { id: e.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    expect(await listCities(db)).toEqual([]);
  });
});

describe("ZM — atualização da base do IBGE", () => {
  it("npm run ibge:update não altera a tabela City", async () => {
    const { owner, org, category } = await setup();
    await createEvent(db, owner, org.id, eventInput(category.id, CURITIBA));
    await makeCity();
    const before = await db.city.findMany({ orderBy: { id: "asc" } });

    const dir = await mkdtemp(path.join(tmpdir(), "ibge-zm-"));
    try {
      const dataPath = path.join(dir, "ibge-municipios.json");
      await writeFile(dataPath, serializeDataset([...allMunicipalities()].slice(1)));
      const api = allMunicipalities().map((m) => ({ id: m.id, nome: m.nome, microrregiao: { mesorregiao: { UF: { sigla: m.uf } } } }));
      const res = await updateMunicipalities({
        dataPath,
        metaPath: path.join(dir, "meta.json"),
        log: () => {},
        fetchImpl: (async () => new Response(JSON.stringify(api))) as unknown as typeof fetch,
      });
      expect(res.status).toBe("updated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(await db.city.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });
});
