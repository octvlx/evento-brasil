// ZN — busca pública inteligente com o banco: frase com cidade ("Rock em São
// Paulo"), artista, local, categoria, texto livre sem acentos, relevância,
// homônimos, visibilidade (rascunho, cancelado, encerrado, organização não
// aprovada) e sugestões agrupadas que não criam nada.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { searchEvents } from "@/server/services/catalog";
import { planSearch, suggestSearch } from "@/server/services/search";
import { rankPublicEvents } from "@/server/services/search-ranking";
import { db, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const owner = await makeUser();
  const [org, pendingOrg] = await Promise.all([makeOrg(owner), makeOrg(owner, { status: "PENDING_REVIEW" })]);
  const cat = async (slug: string, name: string) => db.eventCategory.create({ data: { slug, name } });
  const [shows, teatro, festivais, esportes] = await Promise.all([cat("shows-e-musica", "Shows e música"), cat("teatro", "Teatro e espetáculos"), cat("festivais", "Festivais"), cat("esportes", "Esportes")]);
  const city = async (name: string, state: string, slug: string) => db.city.create({ data: { name, state, slug, timezone: "America/Sao_Paulo" } });
  const [sp, rp, cwb, cps, rj, bjPi, bjRs, vazia] = await Promise.all([
    city("São Paulo", "SP", "sao-paulo-sp"),
    city("Ribeirão Preto", "SP", "ribeirao-preto-sp"),
    city("Curitiba", "PR", "curitiba-pr"),
    city("Campinas", "SP", "campinas-sp"),
    city("Rio de Janeiro", "RJ", "rio-de-janeiro-rj"),
    city("Bom Jesus", "PI", "bom-jesus-pi"),
    city("Bom Jesus", "RS", "bom-jesus-rs"),
    city("Santos", "SP", "santos-sp"),
  ]);
  const venue = (name: string, cityId: string) => db.venue.create({ data: { name, cityId, slug: `v-${randomUUID().slice(0, 8)}`, organizationId: org.id } });
  const [municipal, expo] = await Promise.all([venue("Teatro Municipal de Curitiba", cwb.id), venue("São Paulo Expo", sp.id)]);
  const DAY = 86_400_000;
  const ev = async (title: string, o: { cityId: string; categoryId: string; venueId?: string; description?: string; summary?: string; status?: "PUBLISHED" | "DRAFT" | "CANCELLED"; ended?: boolean; orgId?: string; days?: number }) => {
    const startsAt = new Date(Date.now() + (o.ended ? -3 : (o.days ?? 10)) * DAY);
    return db.event.create({
      data: {
        organizationId: o.orgId ?? org.id,
        slug: `e-${randomUUID().slice(0, 10)}`,
        title,
        summary: o.summary ?? null,
        description: o.description ?? "Descrição de teste com mais de vinte caracteres.",
        categoryId: o.categoryId,
        cityId: o.cityId,
        venueId: o.venueId ?? null,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 4 * 3_600_000),
        timezone: "America/Sao_Paulo",
        salesStartAt: new Date(Date.now() - 5 * DAY),
        salesEndAt: startsAt,
        capacity: 100,
        status: o.status ?? "PUBLISHED",
        refundPolicy: "Política de teste.",
      },
    });
  };
  const e = {
    rockSp: await ev("Noite do Rock Paulistano", { cityId: sp.id, categoryId: shows.id, venueId: expo.id, days: 12 }),
    rockCwb: await ev("Rock na Praça", { cityId: cwb.id, categoryId: shows.id, days: 5 }),
    sambaSp: await ev("Roda de Samba", { cityId: sp.id, categoryId: shows.id, days: 3 }),
    sertanejoRp: await ev("Festa Sertaneja de Ribeirão", { cityId: rp.id, categoryId: shows.id, description: "O melhor do sertanejo universitário na cidade." }),
    sertanejoSp: await ev("Sertanejo no Parque", { cityId: sp.id, categoryId: shows.id }),
    hamlet: await ev("Hamlet", { cityId: cwb.id, categoryId: teatro.id, venueId: municipal.id }),
    pecaSp: await ev("Peça de comédia", { cityId: sp.id, categoryId: teatro.id }),
    joaoCps: await ev("João Gomes — Turnê Acústica", { cityId: cps.id, categoryId: shows.id }),
    joaoSp: await ev("João Gomes ao vivo", { cityId: sp.id, categoryId: shows.id }),
    festivalRj: await ev("Festival de Música Brasileira", { cityId: rj.id, categoryId: festivais.id, summary: "Dois palcos de música." }),
    showRj: await ev("Show de Verão", { cityId: rj.id, categoryId: shows.id }),
    corridaRj: await ev("Corrida da Orla", { cityId: rj.id, categoryId: esportes.id }),
    bjPi: await ev("Forró em Bom Jesus", { cityId: bjPi.id, categoryId: shows.id }),
    bjRs: await ev("Rodeio Crioulo", { cityId: bjRs.id, categoryId: esportes.id }),
    // Não públicos: nunca aparecem.
    draft: await ev("Rock Secreto em Rascunho", { cityId: sp.id, categoryId: shows.id, status: "DRAFT" }),
    cancelled: await ev("Rock Cancelado", { cityId: sp.id, categoryId: shows.id, status: "CANCELLED" }),
    ended: await ev("Rock que Já Passou", { cityId: sp.id, categoryId: shows.id, ended: true }),
    pending: await ev("Rock de Organização Pendente", { cityId: sp.id, categoryId: shows.id, orgId: pendingOrg.id }),
    santosDraft: await ev("Evento em Santos (rascunho)", { cityId: vazia.id, categoryId: shows.id, status: "DRAFT" }),
  };
  return { e, cities: { sp, rp, cwb, cps, rj, bjPi, bjRs, vazia } };
}

/** Exatamente o que a página /eventos faz com ?q=&cidade=. */
async function search(q: string, cidade?: string) {
  const plan = await planSearch(db, q, cidade);
  const res = await searchEvents(db, { q: plan.text, matchCategoryId: plan.category?.id, citySlug: plan.city?.slug ?? (plan.candidates.length ? undefined : cidade) });
  return { plan, titles: res.events.map((x) => x.title), total: res.total };
}

describe("ZN — busca contextual (frase com cidade)", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seed();
  });

  it("Rock em São Paulo: só rock, só em São Paulo, sem os não públicos", async () => {
    const r = await search("Rock em São Paulo");
    expect(r.plan).toMatchObject({ text: "Rock", city: { slug: "sao-paulo-sp" } });
    expect(r.titles).toEqual(["Noite do Rock Paulistano"]);
  });

  it("Sertanejo em Ribeirão Preto (título ou descrição)", async () => {
    const r = await search("Sertanejo em Ribeirão Preto");
    expect(r.plan.city?.slug).toBe("ribeirao-preto-sp");
    expect(r.titles).toEqual(["Festa Sertaneja de Ribeirão"]);
  });

  it("Teatro em Curitiba: categoria reconhecida e local", async () => {
    const r = await search("Teatro em Curitiba");
    expect(r.plan.category?.slug).toBe("teatro");
    expect(r.titles).toEqual(["Hamlet"]);
  });

  it("João Gomes em Campinas: artista no título, só a cidade pedida", async () => {
    const r = await search("João Gomes em Campinas");
    expect(r.titles).toEqual(["João Gomes — Turnê Acústica"]);
    // Sem cidade: as duas datas do artista.
    expect((await search("joao gomes")).titles.sort()).toEqual(["João Gomes ao vivo", "João Gomes — Turnê Acústica"]);
  });

  it("Shows no Rio de Janeiro: categoria Shows, sem o esporte da mesma cidade", async () => {
    const r = await search("Shows no Rio de Janeiro");
    expect(r.plan).toMatchObject({ text: "Shows", category: { slug: "shows-e-musica" }, city: { slug: "rio-de-janeiro-rj" } });
    expect(r.titles).toContain("Show de Verão");
    expect(r.titles).not.toContain("Corrida da Orla");
  });

  it("só a cidade: todos os eventos públicos dela, por data", async () => {
    const r = await search("São Paulo");
    expect(r.plan).toMatchObject({ text: "", city: { slug: "sao-paulo-sp" } });
    expect([...r.titles].sort()).toEqual(["João Gomes ao vivo", "Noite do Rock Paulistano", "Peça de comédia", "Roda de Samba", "Sertanejo no Parque"]);
    // Sem termo: ordem por data (samba em 3 dias, rock em 12).
    expect(r.titles[0]).toBe("Roda de Samba");
    expect(r.titles.at(-1)).toBe("Noite do Rock Paulistano");
  });

  it("homônimos: sem UF não filtra; com a cidade escolhida, filtra", async () => {
    const amb = await search("Bom Jesus");
    expect(amb.plan.candidates.map((c) => c.slug).sort()).toEqual(["bom-jesus-pi", "bom-jesus-rs"]);
    expect(amb.titles.sort()).toEqual(["Forró em Bom Jesus", "Rodeio Crioulo"]);
    expect((await search("Bom Jesus", "bom-jesus-rs")).titles).toEqual(["Rodeio Crioulo"]);
    expect((await search("Bom Jesus RS")).titles).toEqual(["Rodeio Crioulo"]);
  });

  it("texto livre sem acentos e correspondência parcial", async () => {
    expect((await search("festival de musica")).titles).toEqual(["Festival de Música Brasileira"]);
    expect((await search("FESTIVAL")).titles).toEqual(["Festival de Música Brasileira"]);
    expect((await search("paulistano")).titles).toEqual(["Noite do Rock Paulistano"]);
  });

  it("local: Teatro Municipal e São Paulo Expo", async () => {
    expect((await search("Teatro Municipal")).titles).toEqual(["Hamlet"]);
    expect((await search("sao paulo expo")).titles).toEqual(["Noite do Rock Paulistano"]);
  });

  it("relevância: título igual antes de trecho do título e de descrição", async () => {
    const ranked = await rankPublicEvents(db, "rock");
    const order = ranked.map((r) => r.id);
    expect(order).toEqual([f.e.rockCwb.id, f.e.rockSp.id]);
    expect((await rankPublicEvents(db, "hamlet"))[0].score).toBeGreaterThanOrEqual(100);
    const sertanejo = await rankPublicEvents(db, "sertanejo");
    // "Sertanejo no Parque" (título começa) vem antes da festa que só cita na descrição.
    expect(sertanejo[0].id).toBe(f.e.sertanejoSp.id);
  });

  it("nenhum resultado e termo que não é cidade", async () => {
    expect((await search("ópera wagneriana")).total).toBe(0);
    const r = await search("Rock em Atlântida");
    expect(r.plan.city).toBeNull();
    expect(r.total).toBe(0);
  });

  it("nunca mostra rascunho, cancelado, encerrado ou de organização não aprovada", async () => {
    const all = (await rankPublicEvents(db, "rock")).map((r) => r.id);
    for (const hidden of [f.e.draft, f.e.cancelled, f.e.ended, f.e.pending]) expect(all).not.toContain(hidden.id);
    expect((await search("secreto")).total).toBe(0);
    // Cidade só com rascunho não é reconhecida nem sugerida.
    expect((await search("Rock em Santos")).plan.city).toBeNull();
  });

  it("entrada hostil ou longa: parametrizada e cortada, sem erro", async () => {
    await expect(search("'; DROP TABLE \"Event\"; --")).resolves.toMatchObject({ total: 0 });
    await expect(search("%_%")).resolves.toMatchObject({ total: 0 });
    const long = await search(`rock ${"x".repeat(5000)}`);
    expect(long.plan.raw).toHaveLength(80);
    expect(await db.event.count()).toBeGreaterThan(0);
  });
});

describe("ZN — sugestões", () => {
  beforeEach(async () => {
    await seed();
  });

  it("São: cidades com evento público (nunca Santos, só rascunho) e locais", async () => {
    const groups = await suggestSearch(db, "São");
    const cities = groups.find((g) => g.kind === "city")!.items.map((i) => i.label);
    expect(cities).toEqual(["São Paulo — SP"]);
    expect(groups.find((g) => g.kind === "venue")?.items.map((i) => i.label)).toEqual(["São Paulo Expo"]);
  });

  it("Rock em São / Rock em Cu / Rock em Ca: combinações só onde há rock público", async () => {
    const combos = (await suggestSearch(db, "Rock em São")).find((g) => g.kind === "combo")!.items;
    expect(combos).toEqual([{ kind: "combo", label: "Rock em São Paulo — SP", q: "Rock em São Paulo", citySlug: "sao-paulo-sp" }]);
    expect((await suggestSearch(db, "Rock em Cu")).find((g) => g.kind === "combo")!.items.map((i) => i.label)).toEqual(["Rock em Curitiba — PR"]);
    // Campinas existe e tem eventos, mas nenhum de rock: sem combinação.
    expect((await suggestSearch(db, "Rock em Ca")).find((g) => g.kind === "combo")).toBeUndefined();
  });

  it("eventos e categorias; nada de não públicos", async () => {
    const groups = await suggestSearch(db, "rock");
    expect(groups.find((g) => g.kind === "event")!.items.map((i) => i.label)).toEqual(["Rock na Praça", "Noite do Rock Paulistano"]);
    expect(JSON.stringify(groups)).not.toMatch(/Secreto|Cancelado|Passou|Pendente/);
    expect((await suggestSearch(db, "teatro")).find((g) => g.kind === "category")?.items[0]).toMatchObject({ label: "Teatro e espetáculos" });
  });

  it("menos de 2 letras não consulta; sugerir não cria cidade nem evento", async () => {
    const [cities, events] = await Promise.all([db.city.count(), db.event.count()]);
    expect(await suggestSearch(db, "s")).toEqual([]);
    await suggestSearch(db, "Rock em Ribeirão Pr");
    await suggestSearch(db, "Teatro em Maringá");
    expect(await db.city.count()).toBe(cities);
    expect(await db.event.count()).toBe(events);
  });
});
