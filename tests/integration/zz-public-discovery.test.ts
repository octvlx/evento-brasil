// Páginas públicas: ordenação da busca, eventos relacionados, eventos anteriores do
// organizador, organizadores em destaque, recomendações e panorama de cidades.
import { beforeEach, describe, expect, it } from "vitest";
import {
  cityOverview,
  featuredOrganizers,
  pastOrganizerEvents,
  recommendedEvents,
  relatedEvents,
  searchEvents,
} from "@/server/services/catalog";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const DAY = 86_400_000;

async function cityAndCategory(slug: string) {
  const city = await db.city.create({ data: { slug: `${slug}-rj`, name: slug, state: "RJ", timezone: "America/Sao_Paulo" } });
  const category = await db.eventCategory.create({ data: { slug: `cat-${slug}`, name: `Categoria ${slug}` } });
  return { city, category };
}

async function event(org: { id: string }, opts: { price?: number; days?: number; title?: string; cityId?: string; categoryId?: string; startsAt?: Date; salesStartAt?: Date } = {}) {
  const e = await makeEvent(org, {
    tickets: [{ priceCents: opts.price ?? 10000, quantityTotal: 50 }],
    startsInDays: opts.days,
    startsAt: opts.startsAt,
    salesStartAt: opts.salesStartAt,
  });
  return db.event.update({
    where: { id: e.id },
    data: { ...(opts.title ? { title: opts.title } : {}), ...(opts.cityId ? { cityId: opts.cityId } : {}), ...(opts.categoryId ? { categoryId: opts.categoryId } : {}) },
  });
}

describe("ordenação da busca", () => {
  it("sem texto: data por padrão; menor e maior preço; evento sem ingresso visível vai para o fim", async () => {
    const org = await makeOrg(await makeUser());
    const cheapLate = await event(org, { price: 1000, days: 20 });
    const mid = await event(org, { price: 5000, days: 5 });
    const pricey = await event(org, { price: 30000, days: 10 });
    const hidden = await event(org, { price: 100, days: 3 });
    await db.ticketType.updateMany({ where: { eventId: hidden.id }, data: { isHidden: true } });

    const ids = async (sort?: "data" | "preco-menor" | "preco-maior") => (await searchEvents(db, { sort })).events.map((e) => e.slug);
    expect(await ids()).toEqual([hidden.slug, mid.slug, pricey.slug, cheapLate.slug]);
    expect(await ids("preco-menor")).toEqual([cheapLate.slug, mid.slug, pricey.slug, hidden.slug]);
    expect(await ids("preco-maior")).toEqual([pricey.slug, mid.slug, cheapLate.slug, hidden.slug]);
    expect((await searchEvents(db, { sort: "preco-menor" })).total).toBe(4);
  });

  it("com texto: relevância por padrão; data e preço reordenam só os resultados da busca", async () => {
    const org = await makeOrg(await makeUser());
    const a = await event(org, { title: "Noite de Jazz no Parque", price: 9000, days: 15 });
    const b = await event(org, { title: "Jazz", price: 2000, days: 25 });
    await event(org, { title: "Peça de Teatro", price: 500, days: 2 });
    const relevance = (await searchEvents(db, { q: "jazz" })).events.map((e) => e.slug);
    expect(relevance.sort()).toEqual([a.slug, b.slug].sort());
    expect((await searchEvents(db, { q: "jazz", sort: "data" })).events.map((e) => e.slug)).toEqual([a.slug, b.slug]);
    const cheap = await searchEvents(db, { q: "jazz", sort: "preco-menor" });
    expect(cheap.events.map((e) => e.slug)).toEqual([b.slug, a.slug]);
    expect(cheap.total).toBe(2);
  });
});

describe("eventos relacionados", () => {
  it("mesma categoria e cidade primeiro, depois categoria, depois cidade; nunca o próprio, encerrados ou rascunhos", async () => {
    const org = await makeOrg(await makeUser());
    const rio = await cityAndCategory("rio");
    const sp = await cityAndCategory("outra");
    const current = await event(org, { cityId: rio.city.id, categoryId: rio.category.id, days: 5 });
    const sameBoth = await event(org, { cityId: rio.city.id, categoryId: rio.category.id, days: 30 });
    const sameCat = await event(org, { cityId: sp.city.id, categoryId: rio.category.id, days: 6 });
    const sameCity = await event(org, { cityId: rio.city.id, categoryId: sp.category.id, days: 7 });
    await event(org, { cityId: sp.city.id, categoryId: sp.category.id, days: 4 }); // nada em comum
    const draft = await event(org, { cityId: rio.city.id, categoryId: rio.category.id, days: 8 });
    await db.event.update({ where: { id: draft.id }, data: { status: "DRAFT" } });

    const related = await relatedEvents(db, { id: current.id, categoryId: rio.category.id, cityId: rio.city.id });
    expect(related.map((e) => e.slug)).toEqual([sameBoth.slug, sameCat.slug, sameCity.slug]);
    expect((await relatedEvents(db, { id: current.id, categoryId: rio.category.id, cityId: rio.city.id }, 1)).map((e) => e.slug)).toEqual([sameBoth.slug]);
  });
});

describe("perfil e home", () => {
  it("eventos anteriores do organizador: só os já realizados, mais recentes primeiro", async () => {
    const org = await makeOrg(await makeUser());
    const old = await event(org, { startsAt: new Date(Date.now() - 40 * DAY), salesStartAt: new Date(Date.now() - 60 * DAY) });
    const recent = await event(org, { startsAt: new Date(Date.now() - 5 * DAY), salesStartAt: new Date(Date.now() - 60 * DAY) });
    await event(org, { days: 10 });
    const cancelled = await event(org, { startsAt: new Date(Date.now() - 3 * DAY), salesStartAt: new Date(Date.now() - 60 * DAY) });
    await db.event.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });
    expect((await pastOrganizerEvents(db, org.id)).map((e) => e.slug)).toEqual([recent.slug, old.slug]);
  });

  it("organizadores em destaque: aprovados com eventos no ar, por quantidade", async () => {
    const big = await makeOrg(await makeUser());
    const small = await makeOrg(await makeUser());
    const pending = await makeOrg(await makeUser(), { status: "PENDING_REVIEW" });
    const idle = await makeOrg(await makeUser());
    await event(big);
    await event(big);
    await event(small);
    await event(pending);
    await event(idle, { startsAt: new Date(Date.now() - 5 * DAY), salesStartAt: new Date(Date.now() - 60 * DAY) });
    const orgs = await featuredOrganizers(db);
    expect(orgs.map((o) => [o.id, o.upcoming])).toEqual([
      [big.id, 2],
      [small.id, 1],
    ]);
  });

  it("recomendações: mesma categoria e depois mesma cidade dos pedidos pagos, sem o que já comprou; sem histórico, nada", async () => {
    const org = await makeOrg(await makeUser());
    const rio = await cityAndCategory("rio");
    const other = await cityAndCategory("outra");
    const bought = await event(org, { cityId: rio.city.id, categoryId: rio.category.id });
    const sameCat = await event(org, { cityId: other.city.id, categoryId: rio.category.id, days: 12 });
    const sameCity = await event(org, { cityId: rio.city.id, categoryId: other.category.id, days: 14 });
    await event(org, { cityId: other.city.id, categoryId: other.category.id, days: 3 });
    const buyer = await makeUser();
    expect(await recommendedEvents(db, buyer.id)).toEqual([]);
    const tt = await db.ticketType.findFirstOrThrow({ where: { eventId: bought.id } });
    await buyAndPay(buyer, bought.id, [{ ticketTypeId: tt.id, quantity: 1 }]);
    expect((await recommendedEvents(db, buyer.id)).map((e) => e.slug)).toEqual([sameCat.slug, sameCity.slug]);
  });

  it("panorama de cidades: contagem de eventos futuros por cidade (pelo local, se houver)", async () => {
    const org = await makeOrg(await makeUser());
    const rio = await cityAndCategory("rio");
    await event(org, { cityId: rio.city.id });
    await event(org, { cityId: rio.city.id });
    await event(org, { cityId: rio.city.id, startsAt: new Date(Date.now() - 5 * DAY), salesStartAt: new Date(Date.now() - 60 * DAY) });
    const overview = await cityOverview(db);
    expect(overview.find((c) => c.id === rio.city.id)).toMatchObject({ name: "rio", state: "RJ", events: 2 });
  });
});
