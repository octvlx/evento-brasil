// Política de transferência × estoque, reembolso e portaria: sem mutações financeiras implícitas.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkInTicket } from "@/server/services/checkin";
import { expireStaleOrders } from "@/server/services/orders";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { requestCustomerRefund } from "@/server/services/refunds";
import { qrPayload } from "@/server/services/tickets";
import { acceptTransfer, expireTicketTransfers, requestTransfer } from "@/server/services/transfers";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeVerifiedUser as makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(async () => { expect(await checkFinancialInvariants(db)).toEqual([]); });
const HOUR = 3_600_000;
type User = Awaited<ReturnType<typeof makeUser>>;

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const { order, payment } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
  return { owner, event, buyer, order, payment, ticket };
}

function request(from: User, ticketId: string, to: User, at?: Date) {
  return requestTransfer(db, from, ticketId, { toEmail: to.email, toName: to.name }, undefined, at);
}

async function snapshot(ticketId: string) {
  const ticket = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticketId } });
  return {
    ticket,
    transfers: await db.ticketTransfer.findMany({ where: { ticketId }, orderBy: { createdAt: "asc" } }),
    order: await db.order.findUniqueOrThrow({ where: { id: ticket.orderId } }),
    payments: await db.payment.findMany({ where: { orderId: ticket.orderId }, orderBy: { id: "asc" } }),
    ledger: await db.financialLedgerEntry.findMany({ orderBy: { id: "asc" } }),
    stock: await db.ticketType.findUniqueOrThrow({ where: { id: ticket.ticketTypeId } }),
  };
}

async function moved(from: User, ticketId: string, to: User) {
  const invite = await request(from, ticketId, to);
  await acceptTransfer(db, to, invite.token);
  return db.issuedTicket.findUniqueOrThrow({ where: { id: ticketId } });
}

describe("ZD — política do evento e integridade financeira", () => {
  it("no corte padrão de 24h recusa novo pedido sem alterar ingresso, histórico, estoque ou razão", async () => {
    const { event, buyer, ticket } = await setup();
    expect(event).toMatchObject({ transferDeadlineHours: 24, transferMaxTransfers: 1, transferAllowReturn: false });
    const recipient = await makeUser();
    const before = await snapshot(ticket.id);
    await expect(request(buyer, ticket.id, recipient, new Date(event.startsAt.getTime() - 24 * HOUR))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await snapshot(ticket.id)).toEqual(before);
  });

  it("limite padrão de uma transferência mantém o QR do titular e permite reembolso só ao pagador", async () => {
    const { owner, event, buyer, order, payment, ticket } = await setup();
    const recipient = await makeUser();
    const other = await makeUser();
    const current = await moved(buyer, ticket.id, recipient);
    const before = await snapshot(ticket.id);
    await expect(request(recipient, ticket.id, other)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(await snapshot(ticket.id)).toEqual(before);
    expect((await checkInTicket(db, owner, event.id, qrPayload(ticket))).result).toBe("INVALID");
    await expect(requestCustomerRefund(db, adapter, recipient, order.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const refund = await requestCustomerRefund(db, adapter, buyer, order.id);
    expect(refund).toMatchObject({ paymentId: payment.id, amountCents: order.totalCents, status: "SUCCEEDED" });
    expect((await checkInTicket(db, owner, event.id, qrPayload(current))).result).toBe("REVOKED");
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("devolução explicitamente permitida consome o limite, troca o QR e não cria cobrança", async () => {
    const { buyer, event, ticket, order, payment } = await setup();
    // Este cenário testa uma ida e volta: o evento opta explicitamente por duas transferências.
    await db.event.update({ where: { id: event.id }, data: { transferMaxTransfers: 2, transferAllowReturn: true } });
    const recipient = await makeUser();
    const before = await snapshot(ticket.id);
    const outbound = await moved(buyer, ticket.id, recipient);
    const returned = await moved(recipient, ticket.id, buyer);
    expect(returned).toMatchObject({ holderUserId: buyer.id, userId: buyer.id });
    expect(new Set([ticket.validationToken, outbound.validationToken, returned.validationToken]).size).toBe(3);
    const after = await snapshot(ticket.id);
    expect(after.transfers).toHaveLength(2);
    expect(after.transfers.every((t) => t.status === "ACCEPTED")).toBe(true);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.payments).toEqual(before.payments);
    expect(after.order).toEqual(before.order);
    expect(after.stock).toEqual(before.stock);
    await expect(request(buyer, ticket.id, recipient)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(await snapshot(ticket.id)).toEqual(after);
    expect(await requestCustomerRefund(db, adapter, buyer, order.id)).toMatchObject({ paymentId: payment.id, amountCents: order.totalCents });
  });

  it("proibir devolução depois do convite bloqueia o aceite sem mudar titular ou histórico", async () => {
    const { buyer, event, ticket } = await setup();
    await db.event.update({ where: { id: event.id }, data: { transferMaxTransfers: 3, transferAllowReturn: true } });
    const recipient = await makeUser();
    await moved(buyer, ticket.id, recipient);
    const back = await request(recipient, ticket.id, buyer);
    await db.event.update({ where: { id: event.id }, data: { transferAllowReturn: false } });
    const before = await snapshot(ticket.id);
    await expect(acceptTransfer(db, buyer, back.token)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await snapshot(ticket.id)).toEqual(before);
  });

  it("reserva ativa ocupa limite por conta; aceite recusado preserva convite e funciona após expirar reserva", async () => {
    const { buyer, event, ticket } = await setup();
    await db.event.update({ where: { id: event.id }, data: { maxTicketsPerAccount: 1 } });
    const recipient = await makeUser();
    await buy(recipient, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const invite = await request(buyer, ticket.id, recipient);
    const before = await snapshot(ticket.id);
    await expect(acceptTransfer(db, recipient, invite.token)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(await snapshot(ticket.id)).toEqual(before);
    const at = new Date(Date.now() + HOUR);
    await expireStaleOrders(db, at);
    await acceptTransfer(db, recipient, invite.token, undefined, at);
    expect((await snapshot(ticket.id)).ticket.holderUserId).toBe(recipient.id);
  });

  it("aceite aguardando trava reconfere política atual antes de mudar titular", async () => {
    const { buyer, event, ticket } = await setup();
    const recipient = await makeUser();
    const invite = await request(buyer, ticket.id, recipient);
    const before = await snapshot(ticket.id);
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const policyChange = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${event.id} FOR UPDATE`;
      await tx.event.update({ where: { id: event.id }, data: { transferDeadlineHours: 8760 } });
      locked();
      await gate;
    }, { timeout: 15_000 });
    await ready;
    const acceptance = Promise.allSettled([acceptTransfer(db, recipient, invite.token)]);
    try {
      const until = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < until) {
        const [row] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted`;
        if (row.count > 0) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
    } finally { release(); await policyChange; }
    const [result] = await acceptance;
    expect(result).toMatchObject({ status: "rejected", reason: { code: "INVALID_STATE" } });
    expect(await snapshot(ticket.id)).toEqual(before);
  });

  it("cron, aceite e reembolso no corte encerram o convite sem duplicar estorno", async () => {
    const { buyer, event, ticket, order, payment } = await setup();
    const recipient = await makeUser();
    const invite = await request(buyer, ticket.id, recipient);
    // Convite ainda válido pelo prazo original, mas a política atual já encerrou a transferência.
    await db.event.update({ where: { id: event.id }, data: { transferDeadlineHours: 8760 } });
    const [cron, acceptance, refund] = await Promise.allSettled([
      expireTicketTransfers(db),
      acceptTransfer(db, recipient, invite.token),
      requestCustomerRefund(db, adapter, buyer, order.id),
    ]);
    expect(cron.status).toBe("fulfilled");
    expect(acceptance.status).toBe("rejected");
    expect(refund).toMatchObject({ status: "fulfilled", value: { paymentId: payment.id, amountCents: order.totalCents, status: "SUCCEEDED" } });
    const final = await snapshot(ticket.id);
    expect(final.ticket).toMatchObject({ holderUserId: buyer.id, validationToken: ticket.validationToken, status: "REVOKED" });
    expect(final.transfers[0].status).not.toBe("PENDING");
    expect(await db.refund.count({ where: { orderId: order.id } })).toBe(1);
  });
});
