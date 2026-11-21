// Setor do ingresso, mapa do evento e evento privado (fora das listagens, abre pelo link).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createEvent, duplicateEvent, updateEvent, upsertTicketType } from "@/server/services/events";
import { getPublicEvent, getPublicOrganizer, listSitemapEntries, recordTrackingClick, searchEvents } from "@/server/services/catalog";
import { db, makeCategory, makeCity, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

function eventInput(categoryId: string, cityId: string, extra: Record<string, unknown> = {}) {
  return {
    title: "Festival Mapa Teste",
    description: "Um festival de teste com descrição longa o suficiente.",
    categoryId,
    locationType: "VENUE" as const,
    newVenue: { name: "Arena Teste", addressLine: "Rua Exemplo, 100", cityId },
    timezone: "America/Sao_Paulo" as const,
    startsAtLocal: "2030-05-10T20:00",
    endsAtLocal: "2030-05-10T23:00",
    salesStartLocal: "2026-01-01T00:00",
    salesEndLocal: "2030-05-10T20:00",
    ageRestriction: 0,
    capacity: 200,
    refundPolicy: "Reembolso em até 7 dias após a compra.",
    ...extra,
  };
}

describe("evento privado", () => {
  it("some da busca, do perfil e do sitemap, mas abre pelo link e pelo link rastreado", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const listed = await makeEvent(org);
    const hidden = await makeEvent(org);
    await db.event.update({ where: { id: hidden.id }, data: { isUnlisted: true, title: "Festa Secreta Unica" } });

    const search = await searchEvents(db, {});
    expect(search.events.map((e) => e.id)).toContain(listed.id);
    expect(search.events.map((e) => e.id)).not.toContain(hidden.id);
    // Busca por texto (ranking em SQL) também não acha.
    expect((await searchEvents(db, { q: "Festa Secreta Unica" })).total).toBe(0);

    const profile = await getPublicOrganizer(db, org.slug);
    expect(profile!.events.map((e) => e.id)).toEqual([listed.id]);
    expect((await listSitemapEntries(db)).events.map((e) => e.slug)).not.toContain(hidden.slug);

    // Pelo link: a página abre normalmente.
    expect((await getPublicEvent(db, hidden.slug))?.event.id).toBe(hidden.id);
    // Link rastreado do evento privado continua contando o clique e levando à página.
    const code = randomUUID().replace(/-/g, "").slice(0, 10);
    await db.trackingLink.create({ data: { organizationId: org.id, eventId: hidden.id, code, name: "Convite", createdById: owner.id } });
    expect((await recordTrackingClick(db, code))?.event.slug).toBe(hidden.slug);
  });
});

describe("mapa, privado e setor pelo serviço", () => {
  it("grava, edita e copia na duplicação; recusa URL de mapa estranha", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const [category, city] = await Promise.all([makeCategory(), makeCity()]);
    const event = await createEvent(db, owner, org.id, eventInput(category.id, city.id, { mapImageUrl: "/uploads/events/x/mapa.png", isUnlisted: true }));
    expect(event).toMatchObject({ mapImageUrl: "/uploads/events/x/mapa.png", isUnlisted: true });

    const tt = await upsertTicketType(db, owner, event.id, { name: "Camarote 1º lote", sector: "  Camarote  ", kind: "VIP", priceCents: 5000, quantityTotal: 10 });
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).sector).toBe("Camarote");

    const venueId = (await db.event.findUniqueOrThrow({ where: { id: event.id } })).venueId!;
    const base = eventInput(category.id, city.id, { venueId, newVenue: undefined });
    const updated = await updateEvent(db, owner, event.id, { ...base, mapImageUrl: "", isUnlisted: false });
    expect(updated).toMatchObject({ mapImageUrl: null, isUnlisted: false });
    await updateEvent(db, owner, event.id, { ...base, mapImageUrl: "https://cdn.example/mapa.webp", isUnlisted: true });

    const copy = await duplicateEvent(db, owner, event.id, "2031-01-10T20:00");
    const copied = await db.event.findUniqueOrThrow({ where: { id: copy.id }, include: { ticketTypes: true } });
    expect(copied).toMatchObject({ mapImageUrl: "https://cdn.example/mapa.webp", isUnlisted: true });
    expect(copied.ticketTypes.map((t) => t.sector)).toEqual(["Camarote"]);

    await expect(updateEvent(db, owner, event.id, { ...base, mapImageUrl: "javascript:alert(1)" })).rejects.toThrow();
    await expect(updateEvent(db, owner, event.id, { ...base, mapImageUrl: "//evil.example/x.png" })).rejects.toThrow();
  });

  it("o banco recusa setor vazio ou longo demais", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org);
    const tt = await db.ticketType.findFirstOrThrow({ where: { eventId: event.id } });
    await expect(db.ticketType.update({ where: { id: tt.id }, data: { sector: "   " } })).rejects.toThrow();
    await expect(db.ticketType.update({ where: { id: tt.id }, data: { sector: "x".repeat(61) } })).rejects.toThrow();
  });
});
