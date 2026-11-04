// L7c — parte pública da reserva da meia-entrada (Postgres real): a página do evento
// (getPublicEvent), a revisão do checkout e createOrder concordam sobre o que está
// disponível; o anunciado é aceito e o +1 é recusado, com a mesma mensagem.
import { beforeEach, describe, expect, it } from "vitest";
import { halfPriceRequestMessage } from "@/features/half-price/quota";
import { encryptPII, hashToken } from "@/server/crypto";
import { getPublicEvent, searchEvents } from "@/server/services/catalog";
import { checkHalfPriceSelection, createCheckoutDraft, getCheckoutReview, prepareCheckoutReview } from "@/server/services/checkout-review";
import { createOrder } from "@/server/services/orders";
import { db, makeEvent, makeOrg, makeUser, orderInput, resetDb, type TicketSpec } from "../support/fixtures";

beforeEach(resetDb);

const HOUR = 3_600_000;
const FULL = (quantityTotal: number, extra: Partial<TicketSpec> = {}): TicketSpec => ({ priceCents: 10000, quantityTotal, maxPerOrder: 50, ...extra });
const HALF = (quantityTotal: number, extra: Partial<TicketSpec> = {}): TicketSpec => ({ priceCents: 5000, quantityTotal, kind: "HALF_PRICE", maxPerOrder: 50, ...extra });

async function setup(opts: Parameters<typeof makeEvent>[1] = {}) {
  const org = await makeOrg(await makeUser());
  const event = await makeEvent(org, { capacity: 10, tickets: [FULL(10), HALF(10)], ...opts });
  return { event, full: event.ticketTypes[0], half: event.ticketTypes[1] };
}

const buyOrder = async (eventId: string, ticketTypeId: string, quantity: number, now?: Date) =>
  createOrder(db, await makeUser(), orderInput(eventId, [{ ticketTypeId, quantity }], { halfPriceDeclaration: true }), { providerIsSimulated: true, now });

const publicType = async (slug: string, id: string, now: Date) => {
  const data = (await getPublicEvent(db, slug, now))!;
  return { data, type: data.event.ticketTypes.find((t) => t.id === id)! };
};

/** O disponível anunciado é aceito (revisão e pedido) e o +1 é recusado pelo pedido. */
async function expectConsistent(event: { id: string; slug: string }, typeId: string, now: Date) {
  const { type } = await publicType(event.slug, typeId, now);
  const buyer = await makeUser();
  const items = (quantity: number) => [{ ticketTypeId: typeId, quantity }];
  const plusOne = await checkHalfPriceSelection(db, event.id, buyer.id, items(type.available + 1), now);
  const refused = await createOrder(db, buyer, orderInput(event.id, items(type.available + 1), { halfPriceDeclaration: true }), { providerIsSimulated: true, now }).then(
    () => null,
    (e: unknown) => e as { code: string; message: string },
  );
  expect(refused?.code).toBe("SOLD_OUT");
  // Quando a regra da meia é quem recusa, a revisão mostra a mesma mensagem do pedido.
  // (Sem estoque no tipo, o pedido recusa primeiro por estoque; ambos recusam.)
  if (plusOne.message && type.unavailableReason !== "SOLD_OUT") expect(refused?.message).toBe(plusOne.message);
  if (type.available > 0) {
    expect((await checkHalfPriceSelection(db, event.id, buyer.id, items(type.available), now)).message).toBeNull();
    const accepted = await createOrder(db, buyer, orderInput(event.id, items(type.available), { halfPriceDeclaration: true }), { providerIsSimulated: true, now });
    expect(accepted.status).toBe("PENDING_PAYMENT");
  }
  return plusOne.message;
}

describe("L7c públicas — consistência página × revisão × pedido", () => {
  it("durante o prazo: inteira limitada pela reserva (6 de 10), meia com tudo; formato público mínimo", async () => {
    const { event, full } = await setup();
    const now = new Date();
    const { data } = await publicType(event.slug, full.id, now);
    expect(data.halfPrice).toEqual({
      status: "RESERVED",
      reserveActive: true,
      releaseAt: new Date(event.startsAt.getTime() - 48 * HOUR),
      deadlineHours: 48,
      halfAvailable: 10,
      fullAvailable: 6,
      halfUnavailableReason: null,
    });
    expect(data).not.toHaveProperty("halfPriceLeft");
    expect(data.event.ticketTypes.map((t) => [t.available, t.unavailableReason])).toEqual([[6, null], [10, null]]);
    const message = await expectConsistent(event, full.id, now);
    expect(message).toBe(halfPriceRequestMessage("RESERVED_FOR_HALF_PRICE", data.halfPrice.releaseAt, event.timezone));
    expect(message).toMatch(/reservados para meia-entrada até \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/);
  });

  it("durante o prazo: a meia anunciada é aceita e o +1 é recusado", async () => {
    const { event, half } = await setup();
    await expectConsistent(event, half.id, new Date());
  });

  it("inteira barrada pela reserva: motivo próprio, meia segue à venda, card não fica esgotado", async () => {
    const { event, full, half } = await setup({ tickets: [FULL(10), HALF(2)] });
    const now = new Date();
    await buyOrder(event.id, full.id, 6, now);
    const { data, type } = await publicType(event.slug, full.id, now);
    expect(type).toMatchObject({ available: 0, unavailableReason: "RESERVED_FOR_HALF_PRICE" });
    expect(data.halfPrice).toMatchObject({ reserveActive: true, fullAvailable: 0, halfAvailable: 2 });
    expect(data.availability).not.toBe("SOLD_OUT");
    expect((await searchEvents(db, {}, now)).events.find((c) => c.slug === event.slug)?.availability).not.toBe("SOLD_OUT");
    const message = await expectConsistent(event, full.id, now);
    expect(message).toContain("reservados para meia-entrada");
    expect((await publicType(event.slug, half.id, now)).type.available).toBe(2);
  });

  it("depois do prazo: a reserva termina, inteira volta (estoque restante) e a meia continua à venda", async () => {
    const { event, full, half } = await setup();
    const after = new Date(event.startsAt.getTime() - 24 * HOUR);
    await buyOrder(event.id, full.id, 6, after);
    const { data, type } = await publicType(event.slug, full.id, after);
    expect(data.halfPrice).toMatchObject({ status: "RELEASED", reserveActive: false, fullAvailable: 4 });
    expect(type).toMatchObject({ available: 4, unavailableReason: null });
    expect((await publicType(event.slug, half.id, after)).type).toMatchObject({ available: 4, unavailableReason: null });
    expect(await expectConsistent(event, full.id, after)).toBeNull();
  });

  it("cota de meia esgotada (limite de 40%): motivo distinto de ingressos esgotados, durante o prazo", async () => {
    const { event, full, half } = await setup({ halfPriceQuotaBps: 4000 });
    const now = new Date();
    await buyOrder(event.id, half.id, 4, now);
    const { data, type } = await publicType(event.slug, half.id, now);
    expect(type).toMatchObject({ available: 0, unavailableReason: "HALF_QUOTA_EXHAUSTED" });
    expect(data.halfPrice).toMatchObject({ status: "EXHAUSTED", halfAvailable: 0, halfUnavailableReason: "QUOTA_EXHAUSTED" });
    expect(await expectConsistent(event, half.id, now)).toBe("Cota de meia-entrada esgotada.");
    expect((await publicType(event.slug, full.id, now)).type.available).toBeGreaterThan(0);
  });

  it("cota esgotada continua esgotada depois do prazo (a data não a devolve)", async () => {
    const { event, half } = await setup({ halfPriceQuotaBps: 4000 });
    const after = new Date(event.startsAt.getTime() - 24 * HOUR);
    await buyOrder(event.id, half.id, 4, after);
    const { type } = await publicType(event.slug, half.id, after);
    expect(type).toMatchObject({ available: 0, unavailableReason: "HALF_QUOTA_EXHAUSTED" });
    expect(await expectConsistent(event, half.id, after)).toBe("Cota de meia-entrada esgotada.");
  });

  it("ingressos esgotados: motivo SOLD_OUT em todos os tipos e card esgotado", async () => {
    const { event, full, half } = await setup({ tickets: [FULL(5), HALF(5)] });
    const now = new Date();
    await buyOrder(event.id, full.id, 5, now);
    await buyOrder(event.id, half.id, 5, now);
    const { data } = await publicType(event.slug, full.id, now);
    expect(data.event.ticketTypes.map((t) => [t.available, t.unavailableReason])).toEqual([[0, "SOLD_OUT"], [0, "SOLD_OUT"]]);
    expect(data.availability).toBe("SOLD_OUT");
    expect((await searchEvents(db, {}, now)).events.find((c) => c.slug === event.slug)?.availability).toBe("SOLD_OUT");
    await expectConsistent(event, full.id, now);
  });

  it("regime não sujeito: sem reserva, a página mostra o estoque simples", async () => {
    const { event, full } = await setup({ halfPriceRegime: "NOT_SUBJECT" });
    const { data, type } = await publicType(event.slug, full.id, new Date());
    expect(data.halfPrice).toMatchObject({ status: "NOT_APPLICABLE", reserveActive: false });
    expect(type).toMatchObject({ available: 10, unavailableReason: null });
    await expectConsistent(event, full.id, new Date());
  });
});

describe("L7c públicas — revisão do checkout", () => {
  it("prepareCheckoutReview recusa a inteira reservada com o motivo, antes de criar o pedido", async () => {
    const { event, full } = await setup();
    await buyOrder(event.id, full.id, 6);
    let buyer = await makeUser();
    buyer = await db.user.update({
      where: { id: buyer.id },
      data: { emailVerifiedAt: new Date(), cpfEncrypted: encryptPII("52998224725"), cpfHash: hashToken("52998224725"), cpfLast2: "25", birthDate: new Date("1990-01-01T00:00:00Z") },
    });
    await db.userAddress.create({ data: { userId: buyer.id, postalCode: "01001000", street: "Praça da Sé", number: "1", district: "Sé", city: "São Paulo", state: "SP" } });
    const draft = await createCheckoutDraft(db, orderInput(event.id, [{ ticketTypeId: full.id, quantity: 1 }]));
    const ordersBefore = await db.order.count();
    await expect(prepareCheckoutReview(db, buyer, draft.draftId, draft.token)).rejects.toMatchObject({
      code: "SOLD_OUT",
      message: expect.stringContaining("reservados para meia-entrada até"),
    });
    expect(await db.order.count()).toBe(ordersBefore);
    const review = await getCheckoutReview(db, buyer, draft.draftId, draft.token);
    expect(review.halfPrice?.message).toContain("reservados para meia-entrada até");
    expect(review.halfPrice?.availability[full.id]).toEqual({ available: 0, reason: "RESERVED_FOR_HALF_PRICE" });
  });

  it("o pedido pendente do próprio comprador não conta contra a revisão da mesma seleção", async () => {
    const { event, full } = await setup();
    const buyer = await makeUser();
    await createOrder(db, buyer, orderInput(event.id, [{ ticketTypeId: full.id, quantity: 6 }]), { providerIsSimulated: true });
    const check = await checkHalfPriceSelection(db, event.id, buyer.id, [{ ticketTypeId: full.id, quantity: 6 }]);
    expect(check.message).toBeNull();
    expect(check.availability[full.id].available).toBe(6);
  });
});
