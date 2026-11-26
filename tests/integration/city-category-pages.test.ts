import { beforeEach, expect, it } from "vitest";
import { db, resetDb, makeUser, makeOrg, makeEvent } from "../support/fixtures";
import { cityCategoryOverview, listCityCategoryEntries } from "@/server/services/catalog";

beforeEach(resetDb);

it("lista os eventos públicos da categoria na cidade, com números, outras categorias e outras cidades", async () => {
  const org = await makeOrg(await makeUser());
  // makeEvent: São Paulo, categoria "shows".
  const a = await makeEvent(org, { startsInDays: 5, tickets: [{ priceCents: 5000, quantityTotal: 10 }] });
  const b = await makeEvent(org, { startsInDays: 40, tickets: [{ priceCents: 2000, quantityTotal: 10 }] });
  await makeEvent(org, { status: "DRAFT" });
  const unlisted = await makeEvent(org);
  await db.event.update({ where: { id: unlisted.id }, data: { isUnlisted: true } });
  // Outra categoria na mesma cidade e a mesma categoria em outra cidade.
  const teatro = await db.eventCategory.create({ data: { slug: "teatro", name: "Teatro e espetáculos", sortOrder: 2 } });
  const t = await makeEvent(org);
  await db.event.update({ where: { id: t.id }, data: { categoryId: teatro.id } });
  const franca = await db.city.create({ data: { slug: "franca-sp", name: "Franca", state: "SP", timezone: "America/Sao_Paulo" } });
  const f = await makeEvent(org);
  await db.event.update({ where: { id: f.id }, data: { cityId: franca.id } });

  const page = await cityCategoryOverview(db, "sao-paulo-sp", "shows");
  expect(page?.total).toBe(2);
  expect(page?.events.map((e) => e.id)).toEqual([a.id, b.id]);
  expect(page?.stats.firstStartsAt?.getTime()).toBe(a.startsAt.getTime());
  expect(page?.stats.lastStartsAt?.getTime()).toBe(b.startsAt.getTime());
  // Menor total por ingresso, o mesmo do card (na regra padrão dos testes a taxa não é do comprador).
  expect(page?.stats.minPriceCents).toBe(page?.events.find((e) => e.id === b.id)?.minPrice?.totalCents);
  expect(page?.stats.minPriceCents).toBe(2000);
  expect(page?.otherCategories).toEqual([{ slug: "teatro", name: "Teatro e espetáculos", sortOrder: 2, count: 1 }]);
  expect(page?.otherCities.map((c) => [c.slug, c.count])).toEqual([["franca-sp", 1]]);

  expect(await cityCategoryOverview(db, "sao-paulo-sp", "nao-existe")).toBeNull();
  expect(await cityCategoryOverview(db, "cidade-sem-evento", "shows")).toBeNull();
  // Categoria existente sem evento na cidade: página vazia (fica fora do índice), não 404.
  expect((await cityCategoryOverview(db, "franca-sp", "teatro"))?.total).toBe(0);
});

it("sitemap: só pares cidade × categoria com evento público", async () => {
  const org = await makeOrg(await makeUser());
  await makeEvent(org);
  await makeEvent(org);
  await makeEvent(org, { status: "DRAFT" });
  expect(await listCityCategoryEntries(db)).toEqual([{ citySlug: "sao-paulo-sp", categorySlug: "shows" }]);
  await db.event.updateMany({ data: { status: "DRAFT" } });
  expect(await listCityCategoryEntries(db)).toEqual([]);
});
