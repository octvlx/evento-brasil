// Fase 4 (T-TRANSF-ORG): participantes com o titular atual, histórico de transferências
// por ingresso, isolamento entre organizações e CSV; janelas de alteração abertas com
// pedidos de reembolso; alertas do painel.
import { beforeEach, describe, expect, it } from "vitest";
import { listEventChanges } from "@/server/services/event-changes";
import { requestCustomerRefund } from "@/server/services/refunds";
import { attendeesToCsv, listAttendees, listTransferHistory, organizerDashboard } from "@/server/services/reports";
import { acceptTransfer, requestTransfer } from "@/server/services/transfers";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const forbidden = { code: "FORBIDDEN" };

async function setup(opts: { startsInDays?: number; transferMaxTransfers?: number } = {}) {
  const owner = await makeUser();
  const [finance, manager, staff] = await Promise.all([makeUser(), makeUser(), makeUser()]);
  const org = await makeOrg(owner, {
    extraMembers: [
      { userId: finance.id, role: "FINANCE" },
      { userId: manager.id, role: "EVENT_MANAGER" },
      { userId: staff.id, role: "CHECKIN_STAFF" },
    ],
  });
  const event = await makeEvent(org, { startsInDays: opts.startsInDays });
  if (opts.transferMaxTransfers !== undefined) await db.event.update({ where: { id: event.id }, data: { transferMaxTransfers: opts.transferMaxTransfers } });
  const buyer = await makeUser();
  const recipient = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
  return { owner, finance, manager, staff, org, event, buyer, recipient, order, tickets };
}

async function transfer(from: { id: string; platformRole: "USER" | "ADMIN"; status: "ACTIVE" | "SUSPENDED" }, ticketId: string, to: Awaited<ReturnType<typeof makeUser>>) {
  const { token } = await requestTransfer(db, from, ticketId, { toEmail: to.email, toName: `Nome ${to.name}` });
  return acceptTransfer(db, to, token);
}

describe("participantes — titular atual", () => {
  it("depois do aceite mostra o novo titular e marca como transferido; o pedido continua do comprador", async () => {
    const { owner, buyer, recipient, order, tickets, event } = await setup();
    await transfer(buyer, tickets[0].id, recipient);
    const other = await makeUser();
    await requestTransfer(db, buyer, tickets[1].id, { toEmail: other.email, toName: "Outra Pessoa" });

    const rows = await listAttendees(db, owner, event.id);
    const moved = rows.find((r) => r.id === tickets[0].id)!;
    expect(moved).toMatchObject({ holderUserId: recipient.id, userId: buyer.id, holderEmail: recipient.email, transferred: true, pendingTransfer: null, transferCount: 1 });
    expect(moved.holderName).toBe(`Nome ${recipient.name}`);
    expect(moved.order.publicCode).toBe(order.publicCode);

    const pending = rows.find((r) => r.id === tickets[1].id)!;
    expect(pending).toMatchObject({ holderUserId: buyer.id, holderEmail: tickets[1].holderEmail, transferred: false, transferCount: 1 });
    expect(pending.pendingTransfer?.toEmail).toBe(other.email.toLowerCase());
  });

  it("sem holderName/holderEmail no ingresso, usa nome e e-mail da conta titular", async () => {
    const { owner, buyer, tickets, event } = await setup();
    await db.issuedTicket.update({ where: { id: tickets[0].id }, data: { holderName: null, holderEmail: null } });
    const row = (await listAttendees(db, owner, event.id)).find((r) => r.id === tickets[0].id)!;
    expect(row).toMatchObject({ holderName: buyer.name, holderEmail: buyer.email, transferred: false });
  });
});

describe("histórico de transferências", () => {
  it("de → para, datas e situação; sem token, IP ou user agent", async () => {
    // Esta cadeia vai a dois novos titulares; o evento precisa permitir dois aceites.
    const { owner, buyer, recipient, tickets, event } = await setup({ transferMaxTransfers: 2 });
    const third = await makeUser();
    await transfer(buyer, tickets[0].id, recipient);
    await transfer(recipient, tickets[0].id, third);

    const history = await listTransferHistory(db, owner, event.id, tickets[0].id);
    expect(history.map((h) => [h.fromHolderEmail, h.toEmail, h.status])).toEqual([
      [buyer.email, recipient.email.toLowerCase(), "ACCEPTED"],
      [recipient.email, third.email.toLowerCase(), "ACCEPTED"],
    ]);
    for (const h of history) {
      expect(h.ticket.code).toBe(tickets[0].code);
      expect(h.decidedAt).toBeInstanceOf(Date);
      for (const secret of ["tokenHash", "previousTokenHash", "requestIp", "requestUserAgent", "decisionIp", "decisionUserAgent"]) expect(h).not.toHaveProperty(secret);
    }
    // Sem ticketId: todo o evento; o outro ingresso não tem histórico.
    expect(await listTransferHistory(db, owner, event.id)).toHaveLength(2);
    expect(await listTransferHistory(db, owner, event.id, tickets[1].id)).toEqual([]);
  });

  it("só papéis com attendees:read (OWNER, FINANCE, EVENT_MANAGER); equipe de check-in não", async () => {
    const { owner, finance, manager, staff, buyer, recipient, tickets, event } = await setup();
    await transfer(buyer, tickets[0].id, recipient);
    for (const member of [owner, finance, manager]) expect(await listTransferHistory(db, member, event.id)).toHaveLength(1);
    await expect(listTransferHistory(db, staff, event.id)).rejects.toMatchObject(forbidden);
    await expect(listAttendees(db, staff, event.id)).rejects.toMatchObject(forbidden);
    // O próprio comprador/titular não lê pelo serviço do organizador.
    await expect(listTransferHistory(db, buyer, event.id)).rejects.toMatchObject(forbidden);
  });

  it("isolamento entre organizações", async () => {
    const a = await setup();
    await transfer(a.buyer, a.tickets[0].id, a.recipient);
    const b = await setup();
    await expect(listAttendees(db, b.owner, a.event.id)).rejects.toMatchObject(forbidden);
    await expect(listTransferHistory(db, b.owner, a.event.id)).rejects.toMatchObject(forbidden);
    await expect(listTransferHistory(db, b.owner, a.event.id, a.tickets[0].id)).rejects.toMatchObject(forbidden);
    // Evento próprio + ingresso de outra organização: nada vaza.
    expect(await listTransferHistory(db, b.owner, b.event.id, a.tickets[0].id)).toEqual([]);
    expect((await listAttendees(db, b.owner, b.event.id)).map((r) => r.id)).not.toContain(a.tickets[0].id);
  });
});

describe("CSV de participantes", () => {
  it("titular atual, conta, marcador de transferência e fórmulas neutralizadas", async () => {
    const { owner, buyer, recipient, tickets, event } = await setup();
    await transfer(buyer, tickets[0].id, recipient);
    await db.issuedTicket.update({ where: { id: tickets[1].id }, data: { holderName: "=HYPERLINK(\"http://x\")", holderEmail: "@evil" } });

    const csv = attendeesToCsv(await listAttendees(db, owner, event.id));
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe('"codigo","titular","email_titular","conta_titular","transferido","transferencia_pendente","tipo","status","check_in","pedido"');
    const moved = lines.find((l) => l.startsWith(`"${tickets[0].code}"`))!;
    expect(moved).toContain(`"${recipient.email}","${recipient.id}","sim","não"`);
    const injected = lines.find((l) => l.startsWith(`"${tickets[1].code}"`))!;
    expect(injected).toContain(`"'=HYPERLINK(""http://x"")","'@evil","${buyer.id}","não"`);
  });
});

describe("janelas de alteração abertas e pedidos de reembolso", () => {
  it("conta compradores que pediram reembolso pela alteração; prorrogação não conta à parte", async () => {
    const { owner, manager, org, event, buyer, order } = await setup();
    const change = await db.eventChange.create({
      data: {
        eventId: event.id,
        organizationId: org.id,
        actorUserId: owner.id,
        changedFields: ["startsAt"],
        before: {},
        after: {},
        reason: "Mudança de data por motivo de força maior.",
        relevant: true,
        refundUntil: new Date(Date.now() + 5 * 86_400_000),
      },
    });
    await db.eventChange.create({
      data: { eventId: event.id, organizationId: org.id, changedFields: [], before: {}, after: {}, reason: "Prorrogação do prazo.", relevant: true, refundUntil: new Date(Date.now() + 6 * 86_400_000), extendsChangeId: change.id },
    });
    expect((await listEventChanges(db, owner, event.id)).find((c) => c.id === change.id)!.refundRequests).toEqual({ buyers: 0, refunded: 0 });

    const refund = await requestCustomerRefund(db, adapter, buyer, order.id);
    expect(refund).toMatchObject({ reason: "EVENT_CHANGED", eventChangeId: change.id });

    const list = await listEventChanges(db, manager, event.id);
    const original = list.find((c) => c.id === change.id)!;
    expect(original.windowOpen).toBe(true);
    expect(original.refundRequests).toEqual({ buyers: 1, refunded: refund.status === "SUCCEEDED" ? 1 : 0 });
    expect(list.find((c) => c.extendsChangeId === change.id)!.refundRequests).toBeNull();
  });
});

describe("alertas do painel", () => {
  it("transferência pendente perto do início e janela de alteração aberta", async () => {
    const { owner, finance, org, event, buyer, recipient, tickets } = await setup({ startsInDays: 2 });
    const far = await setup({ startsInDays: 10 });
    await requestTransfer(db, buyer, tickets[0].id, { toEmail: recipient.email, toName: "Destinatário Teste" });
    await requestTransfer(db, far.buyer, far.tickets[0].id, { toEmail: far.recipient.email, toName: "Destinatário Longe" });
    await db.eventChange.create({
      data: { eventId: event.id, organizationId: org.id, changedFields: ["venue"], before: {}, after: {}, reason: "Troca de local do evento.", relevant: true, refundUntil: new Date(Date.now() + 86_400_000) },
    });

    const { alerts } = await organizerDashboard(db, owner, org.id);
    const transferAlert = alerts.find((a) => a.text.includes("transferência(s) de ingresso aguardando aceite"));
    expect(transferAlert).toMatchObject({ tone: "warning", href: `/organizador/participantes?evento=${event.id}` });
    expect(transferAlert!.text).toContain(event.title);
    expect(alerts.find((a) => a.text.includes("janela de reembolso por alteração aberta"))).toMatchObject({ href: `/organizador/eventos/${event.id}/editar` });
    expect((await organizerDashboard(db, finance, org.id)).alerts.some((a) => a.text.includes("aguardando aceite"))).toBe(true);

    // Evento distante (outra organização, outro painel): sem alerta de transferência.
    expect((await organizerDashboard(db, far.owner, far.org.id)).alerts.some((a) => a.text.includes("aguardando aceite"))).toBe(false);

    // Janela vencida não alerta (EventChange é somente inserção: avança o relógio).
    expect((await organizerDashboard(db, owner, org.id, new Date(Date.now() + 36 * 3_600_000))).alerts.some((a) => a.text.includes("janela de reembolso"))).toBe(false);
  });
});
