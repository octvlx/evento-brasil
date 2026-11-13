// Relatório de vendas do organizador: totais, por tipo de ingresso e por evento,
// filtros de período e evento, e o CSV de vendas (sem dados pessoais).
import { beforeEach, describe, expect, it } from "vitest";
import { parseSalesPeriod } from "@/features/reports/period";
import { listSalesOrders, salesOrdersToCsv, salesReport } from "@/server/services/reports";
import { requestCustomerRefund } from "@/server/services/refunds";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const ALL = { period: { from: null, to: null } };

async function setup() {
  const owner = await makeUser();
  const finance = await makeUser();
  const manager = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: finance.id, role: "FINANCE" }, { userId: manager.id, role: "EVENT_MANAGER" }] });
  const a = await makeEvent(org, { startsInDays: 20, tickets: [{ priceCents: 10000, quantityTotal: 50 }, { priceCents: 4000, quantityTotal: 50 }] });
  const b = await makeEvent(org, { startsInDays: 40, tickets: [{ priceCents: 2500, quantityTotal: 50 }] });
  const buyers = await Promise.all([makeUser(), makeUser(), makeUser()]);
  const o1 = (await buyAndPay(buyers[0], a.id, [{ ticketTypeId: a.ticketTypes[0].id, quantity: 2 }, { ticketTypeId: a.ticketTypes[1].id, quantity: 1 }])).order;
  const o2 = (await buyAndPay(buyers[1], a.id, [{ ticketTypeId: a.ticketTypes[0].id, quantity: 1 }])).order;
  const o3 = (await buyAndPay(buyers[2], b.id, [{ ticketTypeId: b.ticketTypes[0].id, quantity: 4 }])).order;
  const orders = await db.order.findMany({ where: { id: { in: [o1.id, o2.id, o3.id] } } });
  const byId = new Map(orders.map((o) => [o.id, o]));
  return { owner, finance, manager, org, a, b, buyers, o1: byId.get(o1.id)!, o2: byId.get(o2.id)!, o3: byId.get(o3.id)! };
}

describe("salesReport", () => {
  it("soma pedidos pagos, por tipo e por evento, com ticket médio", async () => {
    const { owner, org, a, b, o1, o2, o3 } = await setup();
    const r = await salesReport(db, owner, org.id, ALL);
    const gross = o1.totalCents + o2.totalCents + o3.totalCents;
    const net = o1.subtotalCents + o2.subtotalCents + o3.subtotalCents;
    expect(r.totals).toMatchObject({ orders: 3, tickets: 8, grossCents: gross, ticketNetCents: net, refundedOrders: 0, refundedCents: 0 });
    expect(net).toBe(2 * 10000 + 4000 + 10000 + 4 * 2500);
    expect(r.totals.averageOrderCents).toBe(Math.round(gross / 3));
    expect(r.totals.averageTicketCents).toBe(Math.round(net / 8));

    const type = (id: string) => r.byTicketType.find((t) => t.ticketTypeId === id)!;
    expect(type(a.ticketTypes[0].id)).toMatchObject({ tickets: 3, netCents: 30000, eventId: a.id, listPriceCents: 10000 });
    expect(type(a.ticketTypes[1].id)).toMatchObject({ tickets: 1, netCents: 4000 });
    expect(type(b.ticketTypes[0].id)).toMatchObject({ tickets: 4, netCents: 10000 });

    expect(r.byEvent.map((e) => [e.eventId, e.orders, e.tickets])).toEqual([
      [b.id, 1, 4],
      [a.id, 2, 4],
    ]);
  });

  it("reembolsado continua como venda do período e aparece à parte", async () => {
    const { owner, org, buyers, o2 } = await setup();
    await requestCustomerRefund(db, adapter, buyers[1], o2.id);
    const r = await salesReport(db, owner, org.id, ALL);
    expect(r.totals).toMatchObject({ orders: 3, refundedOrders: 1, refundedCents: o2.totalCents });
    expect(r.byTicketType.reduce((s, t) => s + t.refundedTickets, 0)).toBe(1);
  });

  it("filtra por período (data do pagamento, horário de São Paulo) e por evento", async () => {
    const { owner, org, a, o1 } = await setup();
    // o1 pago em 10/10/2026 às 23:30 de São Paulo (02:30 UTC do dia 11).
    await db.order.update({ where: { id: o1.id }, data: { paidAt: new Date("2026-10-11T02:30:00Z") } });
    const oct10 = parseSalesPeriod({ de: "2026-10-10", ate: "2026-10-10" });
    const r = await salesReport(db, owner, org.id, { period: oct10 });
    expect(r.totals.orders).toBe(1);
    expect(r.totals.tickets).toBe(3);
    expect((await salesReport(db, owner, org.id, { period: parseSalesPeriod({ de: "2026-10-11", ate: "2026-10-11" }) })).totals.orders).toBe(0);

    const onlyA = await salesReport(db, owner, org.id, { ...ALL, eventId: a.id });
    expect(onlyA.totals.orders).toBe(2);
    expect(onlyA.byEvent.map((e) => e.eventId)).toEqual([a.id]);
  });

  it("período sem vendas devolve zeros, sem divisão por zero", async () => {
    const { owner, org } = await setup();
    const r = await salesReport(db, owner, org.id, { period: parseSalesPeriod({ de: "2020-01-01", ate: "2020-01-31" }) });
    expect(r.totals).toMatchObject({ orders: 0, tickets: 0, grossCents: 0, averageOrderCents: 0, averageTicketCents: 0 });
    expect(r.byTicketType).toEqual([]);
  });

  it("FINANCE vê; EVENT_MANAGER e outra organização não; evento de outra organização é 404", async () => {
    const { finance, manager, org, a } = await setup();
    await expect(salesReport(db, finance, org.id, ALL)).resolves.toBeTruthy();
    await expect(salesReport(db, manager, org.id, ALL)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await makeUser();
    const otherOrg = await makeOrg(other);
    await expect(salesReport(db, other, org.id, ALL)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    await expect(salesReport(db, other, otherOrg.id, { ...ALL, eventId: a.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listSalesOrders(db, other, otherOrg.id, { ...ALL, eventId: a.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("CSV de vendas", () => {
  it("lista os pedidos do filtro sem dados pessoais e neutraliza fórmulas", async () => {
    const { owner, org, a, buyers, o1 } = await setup();
    await db.event.update({ where: { id: a.id }, data: { title: "=HYPERLINK(\"x\")" } });
    const rows = await listSalesOrders(db, owner, org.id, { ...ALL, eventId: a.id });
    expect(rows).toHaveLength(2);
    const csv = salesOrdersToCsv(rows, { organization: org.name, period: "Todo o período", event: "=HYPERLINK(\"x\")", generatedAt: new Date(), statusLabel: (s) => s });
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain(o1.publicCode);
    expect(csv).toContain('"2× ');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/(^|;)"=HYPERLINK/m);
    for (const b of buyers) expect(csv).not.toContain(b.email);
    expect(csv).toContain("Gerado em");
  });
});

describe("parseSalesPeriod", () => {
  it("fim inclusivo vira exclusivo; datas inválidas são ignoradas; ordem invertida é trocada", () => {
    const p = parseSalesPeriod({ de: "2026-11-01", ate: "2026-11-30" });
    expect(p.from?.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(p.to?.toISOString()).toBe("2026-12-01T03:00:00.000Z");
    expect(parseSalesPeriod({ de: "ontem", ate: "2026-13-40" })).toMatchObject({ from: null, to: null, de: "", ate: "" });
    expect(parseSalesPeriod({ de: "2026-11-30", ate: "2026-11-01" })).toMatchObject({ de: "2026-11-01", ate: "2026-11-30" });
  });
});
