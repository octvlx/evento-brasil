// Guarda B1 (ADR 0002): taxa fixa maior que o preço do ingresso, com bearer
// ORGANIZER, deixaria o repasse negativo e o webhook falharia para sempre
// (dinheiro recebido, nenhum ingresso). O pedido é recusado na criação.
import { beforeEach, describe, expect, it } from "vitest";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { buy, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb, ticketType } from "../support/fixtures";

beforeEach(resetDb);

async function setup(bearer: "ORGANIZER" | "BUYER") {
  await db.commissionRule.updateMany({ where: { scope: "PLATFORM" }, data: { fixedCentsPerTicket: 100, bearer } });
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ priceCents: 50, quantityTotal: 10 }, { priceCents: 0, quantityTotal: 10 }] });
  return { event, customer: await makeUser() };
}

describe("Q — guarda contra repasse negativo", () => {
  it("bearer ORGANIZER: ingresso de R$ 0,50 com taxa fixa de R$ 1 é recusado sem reservar nada", async () => {
    const { event, customer } = await setup("ORGANIZER");
    const [cheap] = event.ticketTypes;
    await expect(buy(customer, event.id, [{ ticketTypeId: cheap.id, quantity: 2 }])).rejects.toMatchObject({
      code: "VALIDATION",
      message: "O preço deste ingresso é menor que a taxa da plataforma.",
    });
    expect(await db.order.count()).toBe(0);
    expect(await db.ticketInventoryReservation.count()).toBe(0);
    expect(await ticketType(cheap.id)).toMatchObject({ quantityReserved: 0, quantitySold: 0 });
  });

  it("bearer ORGANIZER: ingresso gratuito continua sendo emitido", async () => {
    const { event, customer } = await setup("ORGANIZER");
    const free = event.ticketTypes[1];
    const order = await buy(customer, event.id, [{ ticketTypeId: free.id, quantity: 1 }]);
    expect(order).toMatchObject({ status: "PAID", totalCents: 0, commissionCents: 0 });
  });

  it("bearer BUYER: pedido criado e pago, razão fecha", async () => {
    const { event, customer } = await setup("BUYER");
    const [cheap] = event.ticketTypes;
    const { order, webhook } = await buyAndPay(customer, event.id, [{ ticketTypeId: cheap.id, quantity: 2 }]);
    expect(order).toMatchObject({ status: "PENDING_PAYMENT", subtotalCents: 100, serviceFeeCents: 208, totalCents: 308, commissionCents: 208 });
    expect(webhook).toBeTruthy();
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await db.issuedTicket.count({ where: { orderId: order.id } })).toBe(2);
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });
});
