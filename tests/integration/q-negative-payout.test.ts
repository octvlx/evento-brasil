// Guarda B1 (ADR 0002): repasse negativo faria o webhook falhar para sempre
// (dinheiro recebido, nenhum ingresso). Como o valor fixo é sempre pago pelo
// comprador e só o percentual sai do repasse, taxa fixa maior que o preço não
// deixa mais o repasse negativo: o pedido é criado e o razão fecha.
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
  it("bearer ORGANIZER: ingresso de R$ 0,50 com taxa fixa de R$ 1 cobra o fixo do comprador e o razão fecha", async () => {
    const { event, customer } = await setup("ORGANIZER");
    const [cheap] = event.ticketTypes;
    const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: cheap.id, quantity: 2 }]);
    // Comissão por ingresso: 7% de 0,50 (0,04, do repasse) + 1,00 fixo (do comprador).
    expect(order).toMatchObject({ subtotalCents: 100, serviceFeeCents: 200, totalCents: 300, commissionCents: 208 });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await ticketType(cheap.id)).toMatchObject({ quantitySold: 2 });
    expect(await checkFinancialInvariants(db)).toEqual([]);
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
