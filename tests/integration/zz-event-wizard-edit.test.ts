// Edição pelo assistente: os valores que a página carrega (wizardPageData) voltam para
// a edição comum (updateEvent) sem mudar nada; as regras da edição continuam valendo.
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_STEPS, wizardToEventInput } from "@/features/organizer/wizard-steps";
import { WIZARD_EVENT_INCLUDE, wizardPageData } from "@/server/services/event-wizard-page";
import { updateEvent } from "@/server/services/events";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function published(withSale: boolean) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { venueCapacity: 500, startsInDays: 30 });
  // O formulário trabalha em minutos (como um evento cadastrado pela tela); a fixture usa ms.
  const minute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000);
  await db.event.update({
    where: { id: event.id },
    data: { startsAt: minute(event.startsAt), endsAt: minute(event.endsAt), salesStartAt: minute(event.salesStartAt), salesEndAt: minute(event.salesEndAt) },
  });
  if (withSale) await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  const full = await db.event.findUniqueOrThrow({ where: { id: event.id }, include: WIZARD_EVENT_INCLUDE });
  const data = await wizardPageData(db, org.id, full, [...DATA_STEPS], true);
  return { owner, org, event: full, data };
}

const shiftDay = (local: string) => {
  const d = new Date(`${local}:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 16);
};

describe("edição pelo assistente", () => {
  it("salvar sem mexer em nada não muda o evento nem registra alteração relevante", async () => {
    const { owner, event, data } = await published(true);
    expect(data.hasSales).toBe(true);
    await updateEvent(db, owner, event.id, wizardToEventInput(data.initial));
    const after = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    for (const k of ["title", "startsAt", "endsAt", "salesStartAt", "salesEndAt", "capacity", "venueId", "refundWindowDays", "refundMinHoursBeforeEvent", "description"] as const)
      expect(after[k]).toEqual(event[k]);
    expect(await db.eventChange.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("com vendas: mudar a data exige motivo; com motivo, registra a alteração", async () => {
    const { owner, event, data } = await published(true);
    const moved = { ...data.initial, startsAtLocal: shiftDay(data.initial.startsAtLocal), endsAtLocal: shiftDay(data.initial.endsAtLocal) };
    await expect(updateEvent(db, owner, event.id, wizardToEventInput(moved))).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).startsAt).toEqual(event.startsAt);
    await updateEvent(db, owner, event.id, wizardToEventInput(moved, "Mudança de agenda do artista"));
    expect(await db.eventChange.findFirst({ where: { eventId: event.id } })).toMatchObject({ reason: "Mudança de agenda do artista" });
  });

  it("com vendas: política de reembolso não pode ficar pior", async () => {
    const { owner, event, data } = await published(true);
    const worse = { ...data.initial, refundWindowDays: String(event.refundWindowDays - 1) };
    await expect(updateEvent(db, owner, event.id, wizardToEventInput(worse))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("sem vendas: título e descrição mudam direto", async () => {
    const { owner, event, data } = await published(false);
    expect(data.hasSales).toBe(false);
    await updateEvent(db, owner, event.id, wizardToEventInput({ ...data.initial, title: "Novo título pelo assistente", description: "Descrição nova com mais de vinte caracteres." }));
    expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ title: "Novo título pelo assistente" });
  });

  it("local próprio (criado pelo evento) volta como 'novo local' e não conta como troca", async () => {
    const { owner, org, event } = await published(true);
    const city = await db.city.findFirstOrThrow();
    const own = await db.venue.create({ data: { organizationId: org.id, cityId: city.id, name: "Galpão Próprio", slug: `galpao-${Date.now()}`, addressLine: "Rua das Flores, 120 – fundos" } });
    await db.event.update({ where: { id: event.id }, data: { venueId: own.id, cityId: city.id } });
    const full = await db.event.findUniqueOrThrow({ where: { id: event.id }, include: WIZARD_EVENT_INCLUDE });
    const data = await wizardPageData(db, org.id, full, [...DATA_STEPS], true);
    expect(data.initial).toMatchObject({ venueMode: "new", newVenue: { name: "Galpão Próprio", street: "Rua das Flores", number: "120", complement: "fundos" } });
    // A cidade do local vem da base do IBGE (pelo nome e UF) e precisa resolver para a mesma cidade.
    expect(data.initial.newVenue.cityIbgeCode).toMatch(/^\d{7}$/);
    await updateEvent(db, owner, event.id, wizardToEventInput(data.initial));
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).venueId).toBe(own.id);
    expect(await db.eventChange.count({ where: { eventId: event.id } })).toBe(0);
  });
});
