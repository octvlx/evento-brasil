// Política de reembolso por evento: dias após a compra e horas antes do evento,
// definidos pelo organizador (padrão 7 dias e 48 horas).
import { beforeEach, describe, expect, it } from "vitest";
import { createEvent, updateEvent } from "@/server/services/events";
import { requestCustomerRefund } from "@/server/services/refunds";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { adapter, buyAndPay, db, makeCategory, makeCity, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const DAY = 86_400_000;

/** "AAAA-MM-DDTHH:mm" no fuso de São Paulo (UTC−3, sem horário de verão). */
function localInput(d: Date) {
  return new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 16);
}

async function eventInput(extra: Record<string, unknown> = {}) {
  const [city, category] = await Promise.all([makeCity(), makeCategory()]);
  const startsAt = new Date(Date.now() + 30 * DAY);
  return {
    title: "Show com política própria",
    description: "Descrição de teste com mais de vinte caracteres.",
    categoryId: category.id,
    locationType: "VENUE" as const,
    newVenue: { name: "Casa de Shows", addressLine: "Rua A, 10", district: "Centro", cityId: city.id, postalCode: "01001-000" },
    timezone: "America/Sao_Paulo" as const,
    startsAtLocal: localInput(startsAt),
    endsAtLocal: localInput(new Date(startsAt.getTime() + 4 * 3_600_000)),
    salesStartLocal: localInput(new Date(Date.now() - DAY)),
    salesEndLocal: localInput(startsAt),
    ageRestriction: 0,
    capacity: 100,
    refundPolicy: "Reembolso conforme os prazos abaixo.",
    ...extra,
  };
}

describe("V — política de reembolso por evento", () => {
  it("evento novo usa 7 dias e 48 horas quando o organizador não informa", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await createEvent(db, owner, org.id, await eventInput());
    expect(event).toMatchObject({ refundWindowDays: 7, refundMinHoursBeforeEvent: 48 });
  });

  it("guarda os valores informados e recusa valores fora dos limites", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await createEvent(db, owner, org.id, await eventInput({ refundWindowDays: "15", refundMinHoursBeforeEvent: "24" }));
    expect(event).toMatchObject({ refundWindowDays: 15, refundMinHoursBeforeEvent: 24 });

    for (const bad of [{ refundWindowDays: -1 }, { refundWindowDays: 366 }, { refundWindowDays: 2.5 }, { refundMinHoursBeforeEvent: 721 }]) {
      await expect(createEvent(db, owner, org.id, await eventInput(bad))).rejects.toThrow();
    }
    // O banco também recusa, mesmo fora do serviço (CHECK).
    await expect(db.event.update({ where: { id: event.id }, data: { refundWindowDays: 400 } })).rejects.toThrow();
    await expect(db.event.update({ where: { id: event.id }, data: { refundMinHoursBeforeEvent: -1 } })).rejects.toThrow();
  });

  it("o pedido de reembolso do comprador segue os prazos do evento", async () => {
    const owner = await makeUser();
    const customer = await makeUser();
    const org = await makeOrg(owner);
    // Evento daqui a 3 dias (72h): com 48h padrão, reembolsável; com 96h, não.
    const strict = await makeEvent(org, { startsInDays: 3 });
    await db.event.update({ where: { id: strict.id }, data: { refundMinHoursBeforeEvent: 96 } });
    const a = await buyAndPay(customer, strict.id, [{ ticketTypeId: strict.ticketTypes[0].id, quantity: 1 }]);
    await expect(requestCustomerRefund(db, adapter, customer, a.order.id)).rejects.toThrow("Reembolsos só até 96h antes do evento.");

    // Prazo de compra de 0 dias: qualquer pedido já pago está fora.
    const noWindow = await makeEvent(org);
    await db.event.update({ where: { id: noWindow.id }, data: { refundWindowDays: 0 } });
    const b = await buyAndPay(customer, noWindow.id, [{ ticketTypeId: noWindow.ticketTypes[0].id, quantity: 1 }]);
    await expect(requestCustomerRefund(db, adapter, customer, b.order.id, new Date(Date.now() + 60_000))).rejects.toThrow("O prazo de 0 dias após a compra terminou.");

    // Pago há 10 dias: fora do padrão de 7, dentro de um prazo de 30.
    const generous = await makeEvent(org, { startsInDays: 40 });
    await db.event.update({ where: { id: generous.id }, data: { refundWindowDays: 30 } });
    const c = await buyAndPay(customer, generous.id, [{ ticketTypeId: generous.ticketTypes[0].id, quantity: 1 }]);
    const refund = await requestCustomerRefund(db, adapter, customer, c.order.id, new Date(Date.now() + 10 * DAY));
    expect(refund.status).toBe("SUCCEEDED");
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("com vendas, o organizador só pode tornar a política mais generosa", async () => {
    const owner = await makeUser();
    const customer = await makeUser();
    const org = await makeOrg(owner);
    const input = await eventInput();
    const event = await createEvent(db, owner, org.id, input);
    // Sem vendas: pode reduzir livremente.
    await updateEvent(db, owner, event.id, { ...input, refundWindowDays: 3, refundMinHoursBeforeEvent: 72 });

    const tt = await db.ticketType.create({ data: { eventId: event.id, name: "Inteira", kind: "GENERAL", priceCents: 5000, quantityTotal: 10 } });
    await db.event.update({ where: { id: event.id }, data: { status: "PUBLISHED" } });
    await buyAndPay(customer, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]);

    const sold = { ...input, refundWindowDays: 3, refundMinHoursBeforeEvent: 72 };
    await expect(updateEvent(db, owner, event.id, { ...sold, refundWindowDays: 2 })).rejects.toThrow(/não pode ser menor que 3 dias/);
    await expect(updateEvent(db, owner, event.id, { ...sold, refundMinHoursBeforeEvent: 96 })).rejects.toThrow(/não pode passar de 72 horas/);
    const better = await updateEvent(db, owner, event.id, { ...sold, refundWindowDays: 10, refundMinHoursBeforeEvent: 24 });
    expect(better).toMatchObject({ refundWindowDays: 10, refundMinHoursBeforeEvent: 24 });
  });
});
