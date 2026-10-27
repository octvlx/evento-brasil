// Decreto 13.108/2026 (R1, L1b): o preço ofertado no catálogo (cards e página
// do evento) é o total por ingresso com a taxa do comprador — o mesmo que o
// pedido cobra.
import { beforeEach, describe, expect, it } from "vitest";
import { cityShowcase, getPublicEvent, searchEvents } from "@/server/services/catalog";
import { setCommissionRule } from "@/server/services/commission";
import { createOrder } from "@/server/services/orders";
import { buy, db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function buyerFeeEvent() {
  const owner = await makeUser();
  const admin = await makeUser({ admin: true });
  const org = await makeOrg(owner);
  const event = await makeEvent(org, {
    halfPriceQuotaBps: 4000,
    tickets: [
      { name: "Inteira", priceCents: 10000, quantityTotal: 50 },
      { name: "Meia", kind: "HALF_PRICE", priceCents: 5000, quantityTotal: 50 },
      { name: "Cortesia", priceCents: 0, quantityTotal: 50 },
    ],
  });
  // 10% + R$ 1,50 por ingresso, pagos pelo comprador, só neste evento.
  await setCommissionRule(db, admin, {
    scope: "EVENT",
    eventId: event.id,
    percentBps: 1000,
    fixedCentsPerTicket: 150,
    bearer: "BUYER",
    processingFeeBearer: "ORGANIZER",
    refundCommissionOnRefund: true,
  });
  return event;
}

describe("R — preço total com taxa desde a oferta", () => {
  it("página do evento: total por tipo = o que o pedido cobra", async () => {
    const event = await buyerFeeEvent();
    const [full, half, free] = event.ticketTypes;
    const data = (await getPublicEvent(db, event.slug))!;
    expect(data.buyerPaysFee).toBe(true);
    expect(data.prices[full.id]).toEqual({ priceCents: 10000, serviceFeeCents: 1150, totalCents: 11150 });
    expect(data.prices[half.id]).toEqual({ priceCents: 5000, serviceFeeCents: 650, totalCents: 5650 });
    expect(data.prices[free.id]).toEqual({ priceCents: 0, serviceFeeCents: 0, totalCents: 0 });

    const buyer = await makeUser();
    const order = await createOrder(
      db,
      buyer,
      orderInput(
        event.id,
        [
          { ticketTypeId: full.id, quantity: 2 },
          { ticketTypeId: half.id, quantity: 1 },
        ],
        { halfPriceDeclaration: true },
      ),
      { providerIsSimulated: true },
    );
    const items = await db.orderItem.findMany({ where: { orderId: order.id } });
    for (const it of items) {
      expect(it.unitPriceCents + it.serviceFeePerUnitCents).toBe(data.prices[it.ticketTypeId].totalCents);
    }
    expect(order.serviceFeeCents).toBe(2 * 1150 + 650);
    expect(order.totalCents).toBe(2 * data.prices[full.id].totalCents + data.prices[half.id].totalCents);
  });

  it("cards (busca e cidade) mostram o menor total pago, com a taxa", async () => {
    const owner = await makeUser();
    const admin = await makeUser({ admin: true });
    const org = await makeOrg(owner);
    const paid = await makeEvent(org, { tickets: [{ priceCents: 8000, quantityTotal: 10 }, { priceCents: 3000, quantityTotal: 10 }] });
    await setCommissionRule(db, admin, { scope: "EVENT", eventId: paid.id, percentBps: 1000, fixedCentsPerTicket: 150, bearer: "BUYER", processingFeeBearer: "ORGANIZER", refundCommissionOnRefund: true });
    // Taxa paga pelo organizador (regra da plataforma): o card não mostra taxa.
    const organizerPays = await makeEvent(org, { tickets: [{ priceCents: 4000, quantityTotal: 10 }] });

    const { events } = await searchEvents(db, {});
    const card = (id: string) => events.find((e) => e.id === id)!;
    expect(card(paid.id).minPrice).toEqual({ priceCents: 3000, serviceFeeCents: 450, totalCents: 3450 });
    expect(card(organizerPays.id).minPrice).toEqual({ priceCents: 4000, serviceFeeCents: 0, totalCents: 4000 });

    const city = await db.city.findUniqueOrThrow({ where: { id: paid.cityId! } });
    const showcase = await cityShowcase(db, city.slug);
    const shelfCard = showcase.shelves.flatMap((s) => s.events).find((e) => e.id === paid.id)!;
    expect(shelfCard.minPrice).toEqual(card(paid.id).minPrice);

    const buyer = await makeUser();
    const order = await buy(buyer, paid.id, [{ ticketTypeId: paid.ticketTypes[1].id, quantity: 1 }]);
    expect(order.totalCents).toBe(card(paid.id).minPrice!.totalCents);
  });
});
