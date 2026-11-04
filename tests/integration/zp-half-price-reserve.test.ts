// L7c — reserva automática da cota legal de meia-entrada (Postgres real).
// Cenários da especificação comum no domínio do financeiro: createOrder,
// pagamento (recusado, tardio, webhook duplicado/fora de ordem), expiração,
// cron e regime. Formulário do organizador e página pública ficam com os seus agentes.
import { beforeEach, describe, expect, it } from "vitest";
import { POST as maintenance } from "@/app/api/cron/maintenance/route";
import { checkHalfPriceRequest, computeHalfPriceState, stockChangeError, ticketAvailability } from "@/features/half-price/quota";
import { loadHalfPriceStateTx, recordHalfPriceReleases, setHalfPriceRegime } from "@/server/services/half-price";
import { cancelPendingOrder, createOrder, expireStaleOrders } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { adapter, db, makeEvent, makeOrg, makeUser, orderInput, resetDb, ticketType, type TicketSpec } from "../support/fixtures";

beforeEach(resetDb);

const HOUR = 3_600_000;
const later = (min: number) => new Date(Date.now() + min * 60_000);
type User = Awaited<ReturnType<typeof makeUser>>;
type Item = { ticketTypeId: string; quantity: number };

const FULL = (quantityTotal: number, extra: Partial<TicketSpec> = {}): TicketSpec => ({ priceCents: 10000, quantityTotal, ...extra });
const HALF = (quantityTotal: number, extra: Partial<TicketSpec> = {}): TicketSpec => ({ priceCents: 5000, quantityTotal, kind: "HALF_PRICE", ...extra });

async function setup(opts: Parameters<typeof makeEvent>[1] = {}) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { capacity: 10, tickets: [FULL(10), HALF(10)], ...opts });
  return { owner, org, event };
}

function order(user: User, eventId: string, items: Item[], now?: Date) {
  return createOrder(db, user, orderInput(eventId, items, { halfPriceDeclaration: true }), { providerIsSimulated: true, now });
}

async function orderAndPay(user: User, eventId: string, items: Item[]) {
  const o = await order(user, eventId, items);
  const payment = await startPayment(db, adapter, user, o.id, "PIX");
  const webhook = await handlePaymentWebhook(db, adapter, await adapter.simulate(payment.providerPaymentId!, "approve"));
  return { order: o, payment, webhook };
}

const audits = (action: string, entityId?: string) => db.auditLog.findMany({ where: { action, ...(entityId ? { entityId } : {}) }, orderBy: { createdAt: "asc" } });
const state = (eventId: string, now = new Date()) => loadHalfPriceStateTx(db, eventId, now).then((c) => c.state);

describe("prazo e liberação (cenários 1–4, 7, 8, 15)", () => {
  it("1–4: 48 h até 10.000 de capacidade do local, 72 h acima; online usa a capacidade do evento", async () => {
    const cases: [Parameters<typeof makeEvent>[1], number][] = [
      [{ venueCapacity: 1000, capacity: 1000 }, 48],
      [{ venueCapacity: 10_000, capacity: 10_000 }, 48],
      [{ venueCapacity: 15_000, capacity: 12_000 }, 72],
      [{ capacity: 12_000 }, 72],
      [{ capacity: 10_000 }, 48],
    ];
    for (const [opts, hours] of cases) {
      const { event } = await setup(opts);
      const s = await state(event.id);
      expect(s.deadlineHours).toBe(hours);
      expect(s.releaseAt.getTime()).toBe(event.startsAt.getTime() - hours * HOUR);
    }
  });

  it("local de 15.000: a reserva já terminou 60 h antes; local de 1.000 ainda reserva", async () => {
    const startsAt = new Date(Date.now() + 10 * 86_400_000);
    const now = new Date(startsAt.getTime() - 60 * HOUR);
    const big = await setup({ startsAt, venueCapacity: 15_000 });
    const small = await setup({ startsAt, venueCapacity: 1000 });
    const buyer = await makeUser();
    await expect(order(buyer, big.event.id, [{ ticketTypeId: big.event.ticketTypes[0].id, quantity: 10 }], now)).resolves.toMatchObject({ status: "PENDING_PAYMENT" });
    await expect(order(buyer, small.event.id, [{ ticketTypeId: small.event.ticketTypes[0].id, quantity: 10 }], now)).rejects.toMatchObject({ code: "SOLD_OUT" });
  });

  it("7 e 15: releaseAt − 1 ms barra a inteira, releaseAt libera — sem cron", async () => {
    const startsAt = new Date(Date.now() + 10 * 86_400_000);
    const { event } = await setup({ startsAt });
    const [full] = event.ticketTypes;
    const releaseAt = new Date(startsAt.getTime() - 48 * HOUR);
    // Reserva pendente criada pouco antes (vale até releaseAt + 14 min).
    await order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 6 }], new Date(releaseAt.getTime() - 60_000));
    const err = await order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 1 }], new Date(releaseAt.getTime() - 1)).catch((e) => e);
    expect(err).toMatchObject({ code: "SOLD_OUT" });
    // releaseAt = startsAt − 48 h; startsAt é exato, então a mensagem traz a hora local.
    const local = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(releaseAt);
    expect(err.message).toMatch(new RegExp(`^Os ingressos restantes estão reservados para meia-entrada até \\d{2}/\\d{2}/\\d{4} às ${local}\\.$`));
    expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ halfPriceReleaseAuditedFor: null });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 4 }], releaseAt)).resolves.toMatchObject({ status: "PENDING_PAYMENT" });
    expect(await ticketType(full.id)).toMatchObject({ quantityReserved: 10 });
  });

  it("8: vendas abertas já dentro do prazo — liberado desde o início", async () => {
    const startsAt = new Date(Date.now() + 24 * HOUR);
    const { event } = await setup({ startsAt, salesStartAt: new Date(Date.now() - HOUR) });
    expect(await state(event.id)).toMatchObject({ status: "RELEASED", reserveActive: false, fullAvailable: 10 });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 10 }])).resolves.toBeTruthy();
  });
});

describe("pedido durante a reserva (cenários 5, 6, 11, 17, 20, 21, 22, 25)", () => {
  it("5 e 6: inteira barrada quando só resta a cota; meia vendida durante o prazo, auditada", async () => {
    const { event } = await setup();
    const [full, half] = event.ticketTypes;
    await order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 6 }]);
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 1 }])).rejects.toThrow(/reservados para meia-entrada até/);
    const buyer = await makeUser();
    const { order: o, webhook } = await orderAndPay(buyer, event.id, [{ ticketTypeId: half.id, quantity: 4 }]);
    expect(webhook.body).toBe("paid");
    expect(await ticketType(half.id)).toMatchObject({ quantitySold: 4, quantityReserved: 0 });
    const [reserved] = await audits("half_price.order_reserved", o.id);
    expect(reserved.metadata).toMatchObject({ halfQuantity: 4, quota: 4, halfReserved: 4, balance: 0, eligibleStock: 10, deadlineHours: 48, status: "EXHAUSTED" });
    const [sold] = await audits("half_price.sold", o.id);
    expect(sold.metadata).toMatchObject({ halfQuantity: 4, late: false, halfSold: 4, halfReserved: 0 });
    // Cota cumprida: a meia segue à venda enquanto houver estoque (sem limite configurado),
    // mas a inteira não tem mais nada (capacidade 10 = 6 + 4).
    expect(await state(event.id)).toMatchObject({ status: "EXHAUSTED", fullAvailable: 0, capacityLeft: 0 });
  });

  it("declaração de meia continua obrigatória", async () => {
    const { event } = await setup();
    await expect(
      createOrder(db, await makeUser(), orderInput(event.id, [{ ticketTypeId: event.ticketTypes[1].id, quantity: 1 }]), { providerIsSimulated: true }),
    ).rejects.toThrow(/declaração/);
  });

  it("11: reserva pendente de meia conta no saldo; expiração devolve e audita", async () => {
    const { event } = await setup();
    const [full, half] = event.ticketTypes;
    const pending = await order(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 2 }]);
    expect(await state(event.id)).toMatchObject({ halfReserved: 2, balance: 2, blocked: 2, fullAvailable: 6 });
    await order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 6 }]);
    expect(await expireStaleOrders(db, later(16))).toBe(2);
    expect(await state(event.id)).toMatchObject({ halfReserved: 0, balance: 4, fullCommitted: 0 });
    const [released] = await audits("half_price.reservation_released", pending.id);
    expect(released.metadata).toMatchObject({ orderStatus: "EXPIRED", reason: "reservation_expired", halfQuantity: 2, halfReserved: 0, balance: 4 });
    // Pedido só de inteira não gera auditoria de meia.
    expect(await db.auditLog.count({ where: { action: "half_price.reservation_released" } })).toBe(1);
  });

  it("11b: liberação pelo createOrder (vencido e pendente substituído) e cancelamento pelo comprador", async () => {
    const { event } = await setup();
    const [, half] = event.ticketTypes;
    const a = await makeUser();
    const first = await order(a, event.id, [{ ticketTypeId: half.id, quantity: 1 }]);
    const second = await order(a, event.id, [{ ticketTypeId: half.id, quantity: 2 }]);
    expect((await audits("half_price.reservation_released", first.id))[0].metadata).toMatchObject({ reason: "replaced_by_new_order", orderStatus: "CANCELLED" });
    await cancelPendingOrder(db, a, second.id);
    expect((await audits("half_price.reservation_released", second.id))[0].metadata).toMatchObject({ reason: "buyer_cancelled" });
    const b = await makeUser();
    const third = await order(b, event.id, [{ ticketTypeId: half.id, quantity: 1 }]);
    // Vencido liberado dentro do próximo createOrder (sem o job).
    await order(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 1 }], later(16));
    expect((await audits("half_price.reservation_released", third.id))[0].metadata).toMatchObject({ reason: "reservation_expired", orderStatus: "EXPIRED" });
    expect(await ticketType(half.id)).toMatchObject({ quantityReserved: 1 });
  });

  it("17: múltiplos lotes de inteira e de meia somam na base e no uso", async () => {
    const { event } = await setup({
      capacity: 100,
      tickets: [FULL(30, { name: "1º lote" }), FULL(30, { name: "2º lote", kind: "EARLY_BIRD" }), HALF(20, { name: "Meia 1º lote" }), HALF(20, { name: "Meia 2º lote" })],
    });
    const [l1, l2, h1, h2] = event.ticketTypes;
    expect(await state(event.id)).toMatchObject({ eligibleStock: 100, quota: 40, fullAvailable: 60 });
    for (let i = 0; i < 3; i++) await order(await makeUser(), event.id, [{ ticketTypeId: l1.id, quantity: 10 }]);
    for (let i = 0; i < 3; i++) await order(await makeUser(), event.id, [{ ticketTypeId: l2.id, quantity: 10 }]);
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: l2.id, quantity: 1 }])).rejects.toThrow(/Não há ingressos/);
    await order(await makeUser(), event.id, [{ ticketTypeId: h1.id, quantity: 10 }]);
    await order(await makeUser(), event.id, [{ ticketTypeId: h2.id, quantity: 10 }]);
    expect(await state(event.id)).toMatchObject({ halfCommitted: 20, fullCommitted: 60, balance: 20, fullAvailable: 0, halfAvailable: 20 });
  });

  it("17b: inteira de outro lote barrada pela reserva comum", async () => {
    const { event } = await setup({ capacity: 20, tickets: [FULL(10), FULL(10, { kind: "VIP", priceCents: 20000 }), HALF(10)] });
    const [gen, vip] = event.ticketTypes;
    // E = min(20, 30) = 20 → Q = 8; inteiras (qualquer lote) até 12.
    await order(await makeUser(), event.id, [{ ticketTypeId: gen.id, quantity: 10 }]);
    await order(await makeUser(), event.id, [{ ticketTypeId: vip.id, quantity: 2 }]);
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: vip.id, quantity: 1 }])).rejects.toMatchObject({ code: "SOLD_OUT", message: expect.stringMatching(/reservados para meia-entrada/) });
  });

  it("20: estoque < 10 e arredondamento floor", async () => {
    for (const [n, q] of [[1, 0], [2, 0], [3, 1], [5, 2], [9, 3], [10, 4]] as const) {
      const { event } = await setup({ capacity: n, tickets: [FULL(n), HALF(n)] });
      const [full, half] = event.ticketTypes;
      expect((await state(event.id)).quota).toBe(q);
      await order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: n - q }]);
      if (q > 0) {
        await expect(order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 1 }])).rejects.toThrow(/reservados para meia-entrada/);
        await expect(order(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: q }])).resolves.toBeTruthy();
      }
    }
  });

  it("21: promocional conta como elegível; cortesia/oculto e gratuito não entram na base", async () => {
    const { event } = await setup({
      capacity: 100,
      tickets: [FULL(40), FULL(20, { kind: "PROMOTIONAL", priceCents: 6000 }), HALF(40), { name: "Cortesia", kind: "FREE", priceCents: 0, quantityTotal: 20 }, FULL(10, { name: "Convite pago" })],
    });
    const [, promo, , courtesy, hiddenPaid] = event.ticketTypes;
    await db.ticketType.update({ where: { id: hiddenPaid.id }, data: { isHidden: true, quantitySold: 5 } });
    // Elegíveis: 40 + 20 + 40 = 100, mas a capacidade menos 5 ocultos vendidos limita a 95.
    expect(await state(event.id)).toMatchObject({ eligibleStock: 95, quota: 38, nonEligibleCommitted: 5 });
    await order(await makeUser(), event.id, [{ ticketTypeId: promo.id, quantity: 10 }]);
    expect((await state(event.id)).fullCommitted).toBe(10);
    // Gratuito público reduz a base; a quantidade aceita é a que o estado anuncia.
    const s = await state(event.id);
    expect(s.nonEligibleAvailable).toBeGreaterThan(0);
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: courtesy.id, quantity: 1 }])).resolves.toMatchObject({ status: "PAID", totalCents: 0 });
    expect((await state(event.id)).nonEligibleCommitted).toBe(6);
  });

  it("22: limite de 50% permite meia além de 40%; configurado < 40% vale 40%", async () => {
    const e50 = (await setup({ halfPriceQuotaBps: 5000 })).event;
    await order(await makeUser(), e50.id, [{ ticketTypeId: e50.ticketTypes[1].id, quantity: 5 }]);
    await expect(order(await makeUser(), e50.id, [{ ticketTypeId: e50.ticketTypes[1].id, quantity: 1 }])).rejects.toThrow(/^Cota de meia-entrada esgotada\.$/);
    const e20 = (await setup({ halfPriceQuotaBps: 2000 })).event;
    await order(await makeUser(), e20.id, [{ ticketTypeId: e20.ticketTypes[1].id, quantity: 4 }]);
    await expect(order(await makeUser(), e20.id, [{ ticketTypeId: e20.ticketTypes[1].id, quantity: 1 }])).rejects.toMatchObject({ code: "SOLD_OUT", message: "Cota de meia-entrada esgotada." });
    expect((await state(e20.id)).warnings).toContain("CONFIGURED_BPS_BELOW_LEGAL");
  });

  it("25: o disponível anunciado por tipo é exatamente o que createOrder aceita", async () => {
    const { event } = await setup({ capacity: 30, tickets: [FULL(30, { maxPerOrder: 30 }), HALF(30, { maxPerOrder: 30 })] });
    const [full, half] = event.ticketTypes;
    await order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 5 }]);
    await order(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 3 }]);
    const ctx = await loadHalfPriceStateTx(db, event.id, new Date());
    const avail = ticketAvailability(ctx.state, ctx.types);
    const fullN = avail.get(full.id)!.available;
    const halfN = avail.get(half.id)!.available;
    expect([fullN, halfN]).toEqual([13, 22]); // E 30, Q 12: inteiras até 18; meia até o resto
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: fullN + 1 }])).rejects.toMatchObject({ code: "SOLD_OUT" });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: fullN }])).resolves.toBeTruthy();
    const after = await loadHalfPriceStateTx(db, event.id, new Date());
    const halfNow = ticketAvailability(after.state, after.types).get(half.id)!.available;
    expect(halfNow).toBe(9);
    expect(ticketAvailability(after.state, after.types).get(full.id)).toEqual({ available: 0, reason: "RESERVED_FOR_HALF_PRICE" });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: halfNow + 1 }])).rejects.toMatchObject({ code: "SOLD_OUT" });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: halfNow }])).resolves.toBeTruthy();
  });
});

describe("concorrência (cenários 9 e 10)", () => {
  it("9: inteiras e meias simultâneas — nenhuma inteira dentro da cota, nada acima da capacidade", async () => {
    const { event } = await setup();
    const [full, half] = event.ticketTypes;
    const buyers = await Promise.all(Array.from({ length: 14 }, () => makeUser()));
    const results = await Promise.allSettled(
      buyers.map((b, i) => order(b, event.id, [{ ticketTypeId: i % 2 ? half.id : full.id, quantity: 1 }])),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const [f, h] = await Promise.all([ticketType(full.id), ticketType(half.id)]);
    // A ordem das transações decide quantas de cada; a regra vale em qualquer ordem:
    // capacidade cheia, nenhuma inteira dentro da cota protegida (Q = 4).
    expect(ok).toBe(10);
    expect(f.quantityReserved + h.quantityReserved).toBe(10);
    expect(f.quantityReserved).toBeLessThanOrEqual(10 - Math.max(4, h.quantityReserved));
    expect(await state(event.id)).toMatchObject({ violation: 0, capacityLeft: 0 });
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    for (const r of rejected) expect(r.reason.message).toMatch(/reservados para meia-entrada|Capacidade do evento esgotada/);
  });

  it("10: muitas inteiras disputando o último lote não protegido", async () => {
    const { event } = await setup({ capacity: 20, tickets: [FULL(20), HALF(20)] });
    const [full] = event.ticketTypes;
    const buyers = await Promise.all(Array.from({ length: 25 }, () => makeUser()));
    const results = await Promise.allSettled(buyers.map((b) => order(b, event.id, [{ ticketTypeId: full.id, quantity: 1 }])));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(12);
    expect(results.filter((r) => r.status === "rejected").every((r) => /reservados para meia-entrada/.test((r as PromiseRejectedResult).reason.message))).toBe(true);
    expect((await ticketType(full.id)).quantityReserved).toBe(12);
    expect(await state(event.id)).toMatchObject({ balance: 8, violation: 0, fullAvailable: 0 });
  });
});

describe("pagamento (cenários 12, 13, 14)", () => {
  it("12: pagamento recusado mantém a reserva até o vencimento; PIX expirado no provedor libera e audita", async () => {
    const { event } = await setup();
    const [, half] = event.ticketTypes;
    const buyer = await makeUser();
    const o = await order(buyer, event.id, [{ ticketTypeId: half.id, quantity: 3 }]);
    const p = await startPayment(db, adapter, buyer, o.id, "PIX");
    expect((await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "reject"))).body).toBe("payment_failed");
    // Regra vigente: recusa não libera; a meia segue reservada para nova tentativa.
    expect(await state(event.id)).toMatchObject({ halfReserved: 3, balance: 1 });
    expect(await audits("half_price.reservation_released", o.id)).toHaveLength(0);

    const buyer2 = await makeUser();
    const o2 = await order(buyer2, event.id, [{ ticketTypeId: half.id, quantity: 1 }]);
    const p2 = await startPayment(db, adapter, buyer2, o2.id, "PIX");
    expect((await handlePaymentWebhook(db, adapter, await adapter.simulate(p2.providerPaymentId!, "expire"))).body).toBe("payment_expired");
    expect((await audits("half_price.reservation_released", o2.id))[0].metadata).toMatchObject({ reason: "payment_expired", orderStatus: "EXPIRED", halfReserved: 3 });
  });

  it("13: pagamento tardio de inteira que invadiria a reserva → não emite e reembolsa", async () => {
    const { event } = await setup();
    const [full] = event.ticketTypes;
    const late = await makeUser();
    const o = await order(late, event.id, [{ ticketTypeId: full.id, quantity: 2 }]);
    const p = await startPayment(db, adapter, late, o.id, "PIX");
    await expireStaleOrders(db, later(16));
    // Outra pessoa compra as 6 inteiras não protegidas.
    await orderAndPay(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 6 }]);
    const res = await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"));
    expect(res.body).toBe("late_payment_refund");
    expect(await db.issuedTicket.count({ where: { orderId: o.id } })).toBe(0);
    expect(await ticketType(full.id)).toMatchObject({ quantitySold: 6, quantityReserved: 0 });
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id }, include: { refunds: true } })).refunds[0]).toMatchObject({ reason: "LATE_PAYMENT_NO_INVENTORY", status: "SUCCEEDED" });
    expect((await audits("half_price.late_payment_blocked", o.id))[0].metadata).toMatchObject({ code: "RESERVED_FOR_HALF_PRICE", balance: 4 });
  });

  it("13b: meia tardia acima do limite configurado → reembolso; dentro do limite → emite e audita", async () => {
    const { event } = await setup({ halfPriceQuotaBps: 4000 });
    const [, half] = event.ticketTypes;
    const late = await makeUser();
    const o = await order(late, event.id, [{ ticketTypeId: half.id, quantity: 2 }]);
    const p = await startPayment(db, adapter, late, o.id, "PIX");
    await expireStaleOrders(db, later(16));
    await orderAndPay(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 3 }]);
    expect((await handlePaymentWebhook(db, adapter, await adapter.simulate(p.providerPaymentId!, "approve"))).body).toBe("late_payment_refund");
    expect((await audits("half_price.late_payment_blocked", o.id))[0].metadata).toMatchObject({ code: "HALF_QUOTA_EXHAUSTED" });
    expect((await ticketType(half.id)).quantitySold).toBe(3);

    const late2 = await makeUser();
    const o2 = await order(late2, event.id, [{ ticketTypeId: half.id, quantity: 1 }]);
    const p2 = await startPayment(db, adapter, late2, o2.id, "PIX");
    await expireStaleOrders(db, later(16));
    expect((await handlePaymentWebhook(db, adapter, await adapter.simulate(p2.providerPaymentId!, "approve"))).body).toBe("late_paid");
    expect((await audits("half_price.sold", o2.id))[0].metadata).toMatchObject({ late: true, halfSold: 4, balance: 0 });
  });

  it("14: webhook duplicado e fora de ordem — idempotente, sem dupla contagem", async () => {
    const { event } = await setup();
    const [, half] = event.ticketTypes;
    const buyer = await makeUser();
    const o = await order(buyer, event.id, [{ ticketTypeId: half.id, quantity: 2 }]);
    const p = await startPayment(db, adapter, buyer, o.id, "PIX");
    // Aviso antigo (gerado antes da aprovação) entregue depois do novo.
    const stale = adapter.buildWebhook(p.providerPaymentId!, "evt-antigo");
    const fresh = await adapter.simulate(p.providerPaymentId!, "approve");
    expect((await handlePaymentWebhook(db, adapter, fresh)).body).toBe("paid");
    expect((await handlePaymentWebhook(db, adapter, stale)).body).toBe("already_processed");
    expect((await handlePaymentWebhook(db, adapter, stale)).body).toBe("duplicate");
    await Promise.all([1, 2, 3].map((i) => handlePaymentWebhook(db, adapter, adapter.buildWebhook(p.providerPaymentId!, `evt-rep-${i}`))));
    expect(await ticketType(half.id)).toMatchObject({ quantitySold: 2, quantityReserved: 0 });
    expect(await audits("half_price.sold", o.id)).toHaveLength(1);
    expect(await db.issuedTicket.count({ where: { orderId: o.id } })).toBe(2);
  });
});

describe("cron (cenários 15, 16)", () => {
  it("16: duas execuções = um quota_released; mudança de data rearma", async () => {
    const startsAt = new Date(Date.now() + 10 * 86_400_000);
    const { event } = await setup({ startsAt });
    const releaseAt = new Date(startsAt.getTime() - 48 * HOUR);
    const before = new Date(releaseAt.getTime() - 1);
    expect(await recordHalfPriceReleases(db, before)).toBe(0);
    expect(await recordHalfPriceReleases(db, releaseAt)).toBe(1);
    expect(await recordHalfPriceReleases(db, releaseAt)).toBe(0);
    expect(await Promise.all([recordHalfPriceReleases(db, releaseAt), recordHalfPriceReleases(db, releaseAt)])).toEqual([0, 0]);
    const rows = await audits("half_price.quota_released", event.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ releaseAt: releaseAt.toISOString(), status: "RELEASED", quota: 4, balance: 4, previousReleaseAt: null });
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).halfPriceReleaseAuditedFor?.toISOString()).toBe(releaseAt.toISOString());

    // Evento adiado um dia: a reserva volta a valer e o registro rearma na nova data.
    const postponed = new Date(startsAt.getTime() + 86_400_000);
    await db.event.update({ where: { id: event.id }, data: { startsAt: postponed, endsAt: new Date(postponed.getTime() + 4 * HOUR), salesEndAt: postponed } });
    expect(await recordHalfPriceReleases(db, releaseAt)).toBe(0);
    const newRelease = new Date(postponed.getTime() - 48 * HOUR);
    expect(await recordHalfPriceReleases(db, newRelease)).toBe(1);
    expect(await recordHalfPriceReleases(db, newRelease)).toBe(0);
    const all = await audits("half_price.quota_released", event.id);
    expect(all).toHaveLength(2);
    expect(all[1].metadata).toMatchObject({ releaseAt: newRelease.toISOString(), previousReleaseAt: releaseAt.toISOString() });
  });

  it("ignora NOT_SUBJECT, sem tipo meia e eventos encerrados; o endpoint expõe a etapa", async () => {
    const soon = new Date(Date.now() + 24 * HOUR);
    const ok = await setup({ startsAt: soon });
    await setup({ startsAt: soon, halfPriceRegime: "NOT_SUBJECT" });
    await setup({ startsAt: soon, tickets: [FULL(10)] });
    const res = await maintenance(new Request("http://localhost/api/cron/maintenance", { method: "POST", headers: { "x-cron-secret": "test-only-cron" } }));
    expect(await res.json()).toMatchObject({ halfPriceReleases: 1, failedSteps: [] });
    expect((await audits("half_price.quota_released")).map((a) => a.entityId)).toEqual([ok.event.id]);
    const again = await maintenance(new Request("http://localhost/api/cron/maintenance", { method: "POST", headers: { "x-cron-secret": "test-only-cron" } }));
    expect(await again.json()).toMatchObject({ halfPriceReleases: 0 });
  });
});

describe("mudanças do organizador — lado do serviço (cenários 18, 19)", () => {
  it("18: redução de capacidade que invade a cota é detectada; aumento não", async () => {
    const { event } = await setup({ capacity: 100, tickets: [FULL(60), HALF(40)] });
    for (let i = 0; i < 6; i++) await order(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 10 }]);
    const ctx = await loadHalfPriceStateTx(db, event.id, new Date());
    const now = new Date();
    expect(stockChangeError(ctx.state, computeHalfPriceState({ ...ctx.input, capacity: 90 }, ctx.types, now))).toMatch(/reserva legal de meia-entrada/);
    const more = ctx.types.map((t) => (t.kind === "HALF_PRICE" ? t : { ...t, quantityTotal: 100 }));
    expect(stockChangeError(ctx.state, computeHalfPriceState({ ...ctx.input, capacity: 140 }, more, now))).toBeNull();
  });

  it("19: data adiada com inteiras vendidas — permitida, inteiras barradas até voltar a caber, meia segue", async () => {
    const startsAt = new Date(Date.now() + 24 * HOUR); // já liberado
    const { event } = await setup({ startsAt });
    const [full, half] = event.ticketTypes;
    await order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 8 }]);
    const postponed = new Date(Date.now() + 10 * 86_400_000);
    await db.event.update({ where: { id: event.id }, data: { startsAt: postponed, endsAt: new Date(postponed.getTime() + 4 * HOUR), salesEndAt: postponed } });
    expect(await state(event.id)).toMatchObject({ reserveActive: true, violation: 2, fullAvailable: 0 });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 1 }])).rejects.toThrow(/reservados para meia-entrada/);
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 2 }])).resolves.toBeTruthy();
    // Cabe de novo quando a meia reduz o saldo: 8 inteiras + 2 meias + saldo 2 = 12 > 10, ainda barra.
    const ctx = await loadHalfPriceStateTx(db, event.id, new Date());
    expect(checkHalfPriceRequest(ctx.input, ctx.types, [{ ticketTypeId: full.id, quantity: 1 }], new Date())).toBe("RESERVED_FOR_HALF_PRICE");
    expect(ctx.state).toMatchObject({ violation: 2, balance: 2, capacityLeft: 0 });
  });
});

describe("regime (cenários 23, 24)", () => {
  it("23: só o admin muda o regime, com motivo; NOT_SUBJECT tira o bloqueio e é auditado", async () => {
    const { owner, event } = await setup();
    const [full] = event.ticketTypes;
    await order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 6 }]);
    await expect(setHalfPriceRegime(db, owner, event.id, "NOT_SUBJECT", "motivo")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = await makeUser({ admin: true });
    await expect(setHalfPriceRegime(db, admin, event.id, "NOT_SUBJECT", "  ")).rejects.toMatchObject({ code: "VALIDATION" });
    await setHalfPriceRegime(db, admin, event.id, "NOT_SUBJECT", "Evento fechado a convidados, fora da Lei 12.933.");
    await setHalfPriceRegime(db, admin, event.id, "NOT_SUBJECT", "Evento fechado a convidados, fora da Lei 12.933."); // sem mudança, sem auditoria
    const [changed, ...rest] = await audits("half_price.regime_changed", event.id);
    expect(rest).toHaveLength(0);
    expect(changed).toMatchObject({ actorUserId: admin.id });
    expect(changed.metadata).toMatchObject({ from: "FEDERAL", to: "NOT_SUBJECT", before: { status: "RESERVED", blocked: 4 }, after: { status: "NOT_APPLICABLE", blocked: 0 } });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: full.id, quantity: 4 }])).resolves.toBeTruthy();
    // De volta ao federal: a nota é opcional e o histórico fica.
    await setHalfPriceRegime(db, admin, event.id, "FEDERAL", null);
    expect(await audits("half_price.regime_changed", event.id)).toHaveLength(2);
    expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ halfPriceRegime: "FEDERAL", halfPriceRegimeNote: null });
  });

  it("24: sem tipo meia → NOT_APPLICABLE, inteira vende tudo", async () => {
    const { event } = await setup({ tickets: [FULL(10)] });
    expect(await state(event.id)).toMatchObject({ status: "NOT_APPLICABLE", notApplicableReason: "NO_HALF_PRICE_TYPE" });
    await expect(order(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 10 }])).resolves.toBeTruthy();
  });
});
