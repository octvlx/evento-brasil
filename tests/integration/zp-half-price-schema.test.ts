// Schema da reserva de meia-entrada (L7c): padrões da migração 20261104120000_half_price_reserve
// e as novas opções da fixture makeEvent (venueCapacity, halfPriceRegime, startsAt, salesStartAt).
import { beforeEach, describe, expect, it } from "vitest";
import { db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

describe("schema da meia-entrada (L7c)", () => {
  it("evento novo nasce no regime FEDERAL, sem nota e sem marcador do cron, e sem local", async () => {
    const event = await makeEvent(await makeOrg(await makeUser()));
    const row = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.halfPriceRegime).toBe("FEDERAL");
    expect(row.halfPriceRegimeNote).toBeNull();
    expect(row.halfPriceReleaseAuditedFor).toBeNull();
    expect(row.venueId).toBeNull();
  });

  it("a coluna no Postgres guarda o enum FEDERAL (lido em SQL cru)", async () => {
    const event = await makeEvent(await makeOrg(await makeUser()));
    const [col] = await db.$queryRaw<{ halfPriceRegime: string }[]>`SELECT "halfPriceRegime"::text AS "halfPriceRegime" FROM "Event" WHERE id = ${event.id}`;
    expect(col.halfPriceRegime).toBe("FEDERAL");
  });

  it("venueCapacity cria um Venue na cidade do evento e liga ao evento", async () => {
    const event = await makeEvent(await makeOrg(await makeUser()), { venueCapacity: 15_000, capacity: 12_000 });
    const row = await db.event.findUniqueOrThrow({ where: { id: event.id }, include: { venue: true } });
    expect(row.venue).not.toBeNull();
    expect(row.venue!.capacity).toBe(15_000);
    expect(row.venue!.cityId).toBe(row.cityId);
    expect(row.capacity).toBe(12_000);
  });

  it("halfPriceRegime, startsAt exato e salesStartAt são respeitados", async () => {
    const startsAt = new Date(Date.now() + 3 * 86_400_000 + 123);
    const salesStartAt = new Date(Date.now() - 2 * 86_400_000);
    const event = await makeEvent(await makeOrg(await makeUser()), { halfPriceRegime: "NOT_SUBJECT", startsAt, startsInDays: 30, salesStartAt });
    expect(event.halfPriceRegime).toBe("NOT_SUBJECT");
    expect(event.startsAt.getTime()).toBe(startsAt.getTime());
    expect(event.endsAt.getTime()).toBeGreaterThan(startsAt.getTime());
    expect(event.salesStartAt.getTime()).toBe(salesStartAt.getTime());
    expect(event.salesEndAt.getTime()).toBe(startsAt.getTime());
  });

  it("o marcador do cron e a nota aceitam valores e a atualização condicional é idempotente", async () => {
    const event = await makeEvent(await makeOrg(await makeUser()));
    const releaseAt = new Date(event.startsAt.getTime() - 48 * 3_600_000);
    const arm = () => db.event.updateMany({
      where: { id: event.id, OR: [{ halfPriceReleaseAuditedFor: null }, { halfPriceReleaseAuditedFor: { not: releaseAt } }] },
      data: { halfPriceReleaseAuditedFor: releaseAt },
    });
    expect((await arm()).count).toBe(1);
    expect((await arm()).count).toBe(0);
    await db.event.update({ where: { id: event.id }, data: { halfPriceRegime: "NOT_SUBJECT", halfPriceRegimeNote: "Evento privado sem venda ao público." } });
    const row = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.halfPriceReleaseAuditedFor!.getTime()).toBe(releaseAt.getTime());
    expect(row.halfPriceRegimeNote).toBe("Evento privado sem venda ao público.");
  });

  it("o CHECK existente de halfPriceQuotaBps continua valendo (0–10000)", async () => {
    const event = await makeEvent(await makeOrg(await makeUser()));
    await expect(db.event.update({ where: { id: event.id }, data: { halfPriceQuotaBps: 10_001 } })).rejects.toThrow();
  });
});
