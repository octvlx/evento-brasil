// Relatório de meia-entrada por evento (R7 do Decreto nº 13.108/2026): números
// de um cenário conhecido, escopo por organização/papel e CSV seguro.
import { beforeEach, describe, expect, it } from "vitest";
import { cancelEvent } from "@/server/services/cancellation";
import { checkInTicket } from "@/server/services/checkin";
import { createOrder } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { requestCustomerRefund } from "@/server/services/refunds";
import { halfPriceReport, halfPriceReportToCsv } from "@/server/services/reports";
import { qrPayload } from "@/server/services/tickets";
import { adapter, db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);

type Buyer = Awaited<ReturnType<typeof makeUser>>;
type Items = { ticketTypeId: string; quantity: number }[];

const order = (user: Buyer, eventId: string, items: Items) =>
  createOrder(db, user, orderInput(eventId, items, { halfPriceDeclaration: true }), { providerIsSimulated: true });

async function orderAndPay(user: Buyer, eventId: string, items: Items) {
  const o = await order(user, eventId, items);
  const payment = await startPayment(db, adapter, user, o.id, "PIX");
  await handlePaymentWebhook(db, adapter, await adapter.simulate(payment.providerPaymentId!, "approve"));
  return o;
}

async function scenario() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, {
    capacity: 100,
    halfPriceQuotaBps: 4000,
    tickets: [
      { name: "Inteira", priceCents: 10000, quantityTotal: 100 },
      { name: "Meia", kind: "HALF_PRICE", priceCents: 5000, quantityTotal: 50 },
    ],
  });
  const [full, half] = event.ticketTypes;
  return { owner, org, event, full, half };
}

describe("relatório de meia-entrada", () => {
  it("bate com um cenário conhecido: vendidas, reservadas, reembolsadas, check-in e cota restante", async () => {
    const { owner, event, full, half } = await scenario();
    // A: 3 meias + 1 inteira pagas. B: 2 meias pagas e reembolsadas. C: 1 meia com check-in. D: 2 meias aguardando pagamento.
    await orderAndPay(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 3 }, { ticketTypeId: full.id, quantity: 1 }]);
    const b = await makeUser();
    const refunded = await orderAndPay(b, event.id, [{ ticketTypeId: half.id, quantity: 2 }]);
    await requestCustomerRefund(db, adapter, b, refunded.id);
    const checked = await orderAndPay(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 1 }]);
    const t = await db.issuedTicket.findFirstOrThrow({ where: { orderId: checked.id } });
    expect((await checkInTicket(db, owner, event.id, qrPayload(t))).result).toBe("ADMITTED");
    await order(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 2 }]);

    const r = await halfPriceReport(db, owner, event.id);
    expect(r).toMatchObject({
      capacity: 100,
      quotaBps: 4000,
      quota: 40,
      sold: 6,
      reserved: 2,
      refunded: 2,
      cancelled: 0,
      otherRevoked: 0,
      valid: 3,
      checkedIn: 1,
      remaining: 32,
    });
    // Todas as vendas caem no mesmo dia (fuso do evento); o pedido reembolsado continua contando como venda do dia.
    expect(r.byDay).toHaveLength(1);
    expect(r.byDay[0]).toMatchObject({ halfSold: 6, halfFaceCents: 30000, totalSold: 7 });

    const csv = halfPriceReportToCsv(r);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe('"Indicador";"Valor"');
    expect(lines).toContain('"Cota de meia-entrada (%)";"40"');
    expect(lines).toContain('"Cota de meia-entrada (ingressos)";"40"');
    expect(lines).toContain('"Meias reembolsadas";"2"');
    expect(lines).toContain('"Cota restante";"32"');
    expect(lines).toContain('"Data da venda";"Meias vendidas";"Valor de face das meias (R$)";"Ingressos vendidos (todos os tipos)"');
    expect(lines.at(-1)).toMatch(/^"\d{2}\/\d{2}\/\d{4}";"6";"300,00";"7"$/);
    // Sem dados pessoais: nenhum e-mail ou nome de comprador.
    expect(csv).not.toMatch(/@|Comprador/);
  });

  it("conta como canceladas as meias revogadas pelo cancelamento do evento", async () => {
    const { owner, event, half } = await scenario();
    await orderAndPay(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 2 }]);
    await cancelEvent(db, adapter, owner, event.id, "Problema com o local");
    const r = await halfPriceReport(db, owner, event.id);
    expect(r).toMatchObject({ sold: 2, cancelled: 2, refunded: 0, valid: 0, checkedIn: 0 });
  });

  it("sem cota definida informa isso em vez de inventar um número", async () => {
    const owner = await makeUser();
    const event = await makeEvent(await makeOrg(owner));
    const r = await halfPriceReport(db, owner, event.id);
    expect(r).toMatchObject({ quota: null, remaining: null, sold: 0, byDay: [] });
    expect(halfPriceReportToCsv(r)).toContain('"Cota restante";"Sem cota definida"');
  });

  it("neutraliza fórmulas de planilha no título do evento", async () => {
    const { owner, event } = await scenario();
    await db.event.update({ where: { id: event.id }, data: { title: '=HYPERLINK("http://x","clique")' } });
    const csv = halfPriceReportToCsv(await halfPriceReport(db, owner, event.id));
    expect(csv).toContain(`"Evento";"'=HYPERLINK(""http://x"",""clique"")"`);
  });

  it("exige finance:read na organização dona do evento", async () => {
    const { owner, org, event } = await scenario();
    const finance = await makeUser();
    const manager = await makeUser();
    const staff = await makeUser();
    await db.organizationMember.createMany({
      data: [
        { organizationId: org.id, userId: finance.id, role: "FINANCE" },
        { organizationId: org.id, userId: manager.id, role: "EVENT_MANAGER" },
        { organizationId: org.id, userId: staff.id, role: "CHECKIN_STAFF" },
      ],
    });
    await expect(halfPriceReport(db, finance, event.id)).resolves.toMatchObject({ quota: 40 });

    // Dono de outra organização, cliente comum, papéis sem finanças e evento inexistente.
    const otherOwner = await makeUser();
    await makeOrg(otherOwner);
    for (const actor of [otherOwner, await makeUser(), manager, staff]) {
      await expect(halfPriceReport(db, actor, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(halfPriceReport(db, owner, "evento-inexistente")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
