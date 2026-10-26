// Fluxo I: acesso a dados de outra organização é rejeitado.
// Fluxo J: compras simultâneas do último ingresso não geram overselling.
import { beforeEach, describe, expect, it } from "vitest";
import { createOrder, getOrderForBuyer } from "@/server/services/orders";
import { moderateEvent, updateEvent, upsertTicketType } from "@/server/services/events";
import { dailySales, listAttendees, organizerFinancials, organizerOverview } from "@/server/services/reports";
import { inviteMember } from "@/server/services/organizers";
import { setCommissionRule } from "@/server/services/commission";
import { buy, buyAndPay, db, makeEvent, makeOrg, makeUser, orderInput, resetDb, ticketType } from "../support/fixtures";

beforeEach(resetDb);

describe("I — autorização entre organizações", () => {
  it("rejeita acesso de membros de outra organização e papéis sem permissão", async () => {
    const ownerA = await makeUser();
    const ownerB = await makeUser();
    const financeA = await makeUser();
    const staffA = await makeUser();
    const orgA = await makeOrg(ownerA, { extraMembers: [{ userId: financeA.id, role: "FINANCE" }, { userId: staffA.id, role: "CHECKIN_STAFF" }] });
    await makeOrg(ownerB);
    const event = await makeEvent(orgA);
    const tt = event.ticketTypes[0];
    const editInput = {
      title: "Hackeado",
      description: "Tentativa de edição por outra organização.",
      categoryId: event.categoryId,
      locationType: "ONLINE" as const,
      onlineUrl: "https://example.com/live",
      timezone: "America/Sao_Paulo" as const,
      startsAtLocal: "2030-01-01T20:00",
      endsAtLocal: "2030-01-01T22:00",
      salesStartLocal: "2026-01-01T00:00",
      salesEndLocal: "2030-01-01T20:00",
      ageRestriction: 0,
      capacity: 100,
      refundPolicy: "Política qualquer de teste.",
    };
    const forbidden = { code: "FORBIDDEN" };
    await expect(updateEvent(db, ownerB, event.id, editInput)).rejects.toMatchObject(forbidden);
    await expect(upsertTicketType(db, ownerB, event.id, { id: tt.id, name: "Grátis", kind: "FREE", priceCents: 0, quantityTotal: 999 })).rejects.toMatchObject(forbidden);
    await expect(listAttendees(db, ownerB, event.id)).rejects.toMatchObject(forbidden);
    await expect(organizerFinancials(db, ownerB, orgA.id)).rejects.toMatchObject(forbidden);
    await expect(organizerOverview(db, ownerB, orgA.id)).rejects.toMatchObject(forbidden);
    await expect(dailySales(db, ownerB, orgA.id)).rejects.toMatchObject(forbidden);
    await expect(inviteMember(db, ownerB, orgA.id, { email: "x@y.com", role: "ADMIN" })).rejects.toMatchObject(forbidden);
    // Papéis internos com escopo limitado.
    await expect(updateEvent(db, financeA, event.id, editInput)).rejects.toMatchObject(forbidden);
    await expect(listAttendees(db, staffA, event.id)).rejects.toMatchObject(forbidden);
    await expect(organizerFinancials(db, staffA, orgA.id)).rejects.toMatchObject(forbidden);
    expect(await organizerFinancials(db, financeA, orgA.id)).toBeTruthy();
    // Funções de plataforma exigem admin.
    await expect(moderateEvent(db, ownerA, event.id, "APPROVE")).rejects.toMatchObject(forbidden);
    await expect(
      setCommissionRule(db, ownerA, { scope: "ORGANIZATION", organizationId: orgA.id, percentBps: 0, fixedCentsPerTicket: 0, bearer: "ORGANIZER", processingFeeBearer: "ORGANIZER", refundCommissionOnRefund: true }),
    ).rejects.toMatchObject(forbidden);
    // Nada mudou.
    expect(await ticketType(tt.id)).toMatchObject({ priceCents: tt.priceCents, quantityTotal: tt.quantityTotal });
  });

  it("comprador não acessa pedido de outra pessoa; conta suspensa não compra", async () => {
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org);
    const alice = await makeUser();
    const bob = await makeUser();
    const order = await buy(alice, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await expect(getOrderForBuyer(db, bob, order.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(buy({ ...bob, status: "SUSPENDED" }, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("organização suspensa não vende e o evento sai da busca pública", async () => {
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org);
    await db.organization.update({ where: { id: org.id }, data: { status: "SUSPENDED" } });
    await expect(buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }])).rejects.toMatchObject({ code: "SALES_CLOSED" });
  });

  it("regra de comissão por organização substitui a padrão e é versionada", async () => {
    const admin = await makeUser({ admin: true });
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org);
    const rule = await setCommissionRule(db, admin, { scope: "ORGANIZATION", organizationId: org.id, percentBps: 500, fixedCentsPerTicket: 0, bearer: "BUYER", processingFeeBearer: "ORGANIZER", refundCommissionOnRefund: true });
    const order = await buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    expect(order).toMatchObject({ subtotalCents: 10000, serviceFeeCents: 500, totalCents: 10500, commissionCents: 500, feePolicyVersion: rule.policyVersion });
  });
});

describe("J — concorrência no último ingresso", () => {
  it("dois compradores simultâneos pelo último ingresso: exatamente um consegue", async () => {
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 1 }] });
    const tt = event.ticketTypes[0];
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const results = await Promise.allSettled([buy(a, event.id, [{ ticketTypeId: tt.id, quantity: 1 }]), buy(b, event.id, [{ ticketTypeId: tt.id, quantity: 1 }])]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "SOLD_OUT" });
    expect(await ticketType(tt.id)).toMatchObject({ quantityReserved: 1, quantitySold: 0 });
  });

  it("40 compradores, 10 ingressos e capacidade 10: nunca vende além", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    // Dois tipos com 8 cada, mas capacidade total 10.
    const event = await makeEvent(org, { capacity: 10, tickets: [{ priceCents: 5000, quantityTotal: 8 }, { priceCents: 9000, quantityTotal: 8 }] });
    const buyers = await Promise.all(Array.from({ length: 40 }, () => makeUser()));
    const results = await Promise.allSettled(
      buyers.map((u, i) => buyAndPay(u, event.id, [{ ticketTypeId: event.ticketTypes[i % 2].id, quantity: 1 }])),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    const types = await db.ticketType.findMany({ where: { eventId: event.id } });
    expect(types.reduce((s, t) => s + t.quantitySold, 0)).toBe(10);
    expect(types.every((t) => t.quantitySold <= t.quantityTotal && t.quantityReserved === 0)).toBe(true);
    expect(await db.issuedTicket.count({ where: { eventId: event.id } })).toBe(10);
    expect((await organizerOverview(db, owner, org.id)).ticketsSold).toBe(10);
  });

  it("o banco impede overselling mesmo com escrita direta", async () => {
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org, { tickets: [{ priceCents: 1000, quantityTotal: 2 }] });
    await expect(db.ticketType.update({ where: { id: event.ticketTypes[0].id }, data: { quantitySold: 3 } })).rejects.toThrow();
    await expect(db.ticketType.update({ where: { id: event.ticketTypes[0].id }, data: { quantityReserved: -1 } })).rejects.toThrow();
  });

  it("pedido com tipo de outro evento é rejeitado", async () => {
    const org = await makeOrg(await makeUser());
    const e1 = await makeEvent(org);
    const e2 = await makeEvent(org);
    await expect(createOrder(db, await makeUser(), orderInput(e1.id, [{ ticketTypeId: e2.ticketTypes[0].id, quantity: 1 }]), { providerIsSimulated: true })).rejects.toThrow(
      /inválido/,
    );
  });
});
