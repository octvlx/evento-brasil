// T-TRANSF (Decreto 13.108/2026, R6): transferência de titularidade gratuita,
// autenticada, rastreável e com histórico imutável; o QR antigo deixa de valer.
import { beforeEach, describe, expect, it } from "vitest";
import { checkInTicket } from "@/server/services/checkin";
import { loadPdfTickets } from "@/server/services/notifications";
import { requestCustomerRefund } from "@/server/services/refunds";
import { qrPayload } from "@/server/services/tickets";
import { acceptTransfer, cancelTransfer, declineTransfer, expireTicketTransfers, findTransferByToken, listMyTransfers, requestTransfer, TRANSFER_POLICY } from "@/server/services/transfers";
import { hashToken } from "@/server/crypto";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

type User = Awaited<ReturnType<typeof makeUser>>;

async function setup(opts: { quantity?: number; startsInDays?: number } = {}) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { startsInDays: opts.startsInDays });
  const buyer = await makeUser();
  const recipient = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: opts.quantity ?? 1 }]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
  return { owner, event, buyer, recipient, order, tickets, ticket: tickets[0] };
}

/** Pede a transferência; o token é o que iria no e-mail (o banco só guarda o hash). */
function request(from: User, ticketId: string, to: User, now?: Date) {
  return requestTransfer(db, from, ticketId, { toEmail: to.email.toUpperCase(), toName: `Nome ${to.name}` }, { ip: "203.0.113.9", userAgent: "vitest" }, now);
}

describe("T-TRANSF — pedido", () => {
  it("cria PENDING gratuita, com hash do token, validade de 48h e auditoria", async () => {
    const { buyer, recipient, ticket, order } = await setup();
    const now = new Date();
    const res = await request(buyer, ticket.id, recipient, now);
    const row = await db.ticketTransfer.findUniqueOrThrow({ where: { id: res.transferId } });
    expect(row).toMatchObject({ status: "PENDING", initiatedBy: "HOLDER", fromUserId: buyer.id, toEmail: recipient.email.toLowerCase(), toUserId: null, requestIp: "203.0.113.9" });
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt!.getTime() - now.getTime()).toBe(TRANSFER_POLICY.acceptWindowHours * 3_600_000);
    expect(await db.auditLog.count({ where: { action: "ticket.transfer.requested", entityId: row.id } })).toBe(1);
    // Gratuita: nenhum pedido ou pagamento novo.
    expect(await db.order.count()).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).totalCents).toBe(order.totalCents);
  });

  it("validade limitada ao início do evento", async () => {
    const { buyer, recipient, ticket, event } = await setup({ startsInDays: 1 });
    const res = await request(buyer, ticket.id, recipient);
    expect(res.expiresAt).toEqual(event.startsAt);
  });

  it("só o titular, com ingresso VALID, pedido PAID e uma pendente por vez", async () => {
    const { owner, buyer, recipient, ticket, tickets, event } = await setup({ quantity: 2 });
    await expect(request(recipient, ticket.id, owner)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requestTransfer(db, buyer, ticket.id, { toEmail: buyer.email, toName: "Eu mesmo" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(requestTransfer(db, buyer, ticket.id, { toEmail: "não-é-email", toName: "X Y" })).rejects.toMatchObject({ code: "VALIDATION" });
    await request(buyer, ticket.id, recipient);
    await expect(request(buyer, ticket.id, owner)).rejects.toMatchObject({ code: "CONFLICT" });

    await checkInTicket(db, owner, event.id, qrPayload(tickets[1]));
    await expect(request(buyer, tickets[1].id, recipient)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("recusa com reembolso em andamento e com evento já iniciado", async () => {
    const a = await setup();
    await requestCustomerRefund(db, adapter, a.buyer, a.order.id);
    await expect(request(a.buyer, a.ticket.id, a.recipient)).rejects.toMatchObject({ code: "INVALID_STATE" });

    const b = await setup();
    await expect(request(b.buyer, b.ticket.id, b.recipient, new Date(b.event.startsAt.getTime() + 1000))).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("pedidos simultâneos do mesmo ingresso: exatamente um fica pendente", async () => {
    const { buyer, ticket } = await setup();
    const others = await Promise.all(Array.from({ length: 5 }, () => makeUser()));
    const results = await Promise.allSettled(others.map((u) => request(buyer, ticket.id, u)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "CONFLICT" });
    expect(await db.ticketTransfer.count({ where: { ticketId: ticket.id, status: "PENDING" } })).toBe(1);
  });
});

describe("T-TRANSF — aceite", () => {
  it("muda o titular, troca o QR (o antigo não admite) e registra o histórico", async () => {
    const { owner, buyer, recipient, ticket, event, order } = await setup();
    const oldPayload = qrPayload(ticket);
    const { token, transferId } = await request(buyer, ticket.id, recipient);
    expect((await findTransferByToken(db, token))?.id).toBe(transferId);

    const res = await acceptTransfer(db, recipient, token, { ip: "198.51.100.1", userAgent: "vitest" });
    expect(res.ticketCode).toBe(ticket.code);

    const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after).toMatchObject({ holderUserId: recipient.id, holderEmail: recipient.email, holderName: `Nome ${recipient.name}`, userId: buyer.id, status: "VALID" });
    expect(after.validationToken).not.toBe(ticket.validationToken);
    // Comprador continua o pagador do pedido (D7 provisório).
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).userId).toBe(buyer.id);

    const row = await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(row).toMatchObject({ status: "ACCEPTED", toUserId: recipient.id, decidedById: recipient.id, previousTokenHash: hashToken(ticket.validationToken), decisionIp: "198.51.100.1" });
    expect(await db.auditLog.count({ where: { action: "ticket.transfer.accepted", entityId: transferId } })).toBe(1);

    // QR antigo: inválido. Novo: admite uma vez.
    expect((await checkInTicket(db, owner, event.id, oldPayload)).result).toBe("INVALID");
    expect((await checkInTicket(db, owner, event.id, qrPayload(after))).result).toBe("ADMITTED");
    expect((await checkInTicket(db, owner, event.id, oldPayload)).result).toBe("INVALID");

    // "Meus ingressos"/PDF pelo titular: o comprador não baixa mais o QR novo.
    expect(await loadPdfTickets(db, { orderId: order.id, holderUserId: buyer.id })).toHaveLength(0);
    expect(await loadPdfTickets(db, { orderId: order.id, holderUserId: recipient.id })).toHaveLength(1);
    expect(await db.issuedTicket.count({ where: { holderUserId: recipient.id } })).toBe(1);

    // Token de uso único.
    await expect(acceptTransfer(db, recipient, token)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("exige o destinatário logado com o e-mail indicado", async () => {
    const { buyer, recipient, ticket } = await setup();
    const intruder = await makeUser();
    const { token } = await request(buyer, ticket.id, recipient);
    await expect(acceptTransfer(db, intruder, token)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(declineTransfer(db, intruder, token)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(acceptTransfer(db, recipient, "x".repeat(43))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } })).holderUserId).toBe(buyer.id);
  });

  it("expirada: o aceite marca EXPIRED e falha; o cron expira as vencidas", async () => {
    const a = await setup();
    const { token, transferId } = await request(a.buyer, a.ticket.id, a.recipient);
    const late = new Date(Date.now() + (TRANSFER_POLICY.acceptWindowHours + 1) * 3_600_000);
    await expect(acceptTransfer(db, a.recipient, token, undefined, late)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } })).status).toBe("EXPIRED");

    const b = await setup();
    const res = await request(b.buyer, b.ticket.id, b.recipient);
    expect(await expireTicketTransfers(db)).toBe(0);
    expect(await expireTicketTransfers(db, late)).toBe(1);
    expect(await db.ticketTransfer.findUniqueOrThrow({ where: { id: res.transferId } })).toMatchObject({ status: "EXPIRED", decidedById: null });
    // Depois de expirar, pode pedir de novo.
    await request(b.buyer, b.ticket.id, b.recipient);
  });

  it("cancelada pelo titular ou recusada pelo destinatário não pode ser aceita", async () => {
    const { buyer, recipient, ticket } = await setup();
    const first = await request(buyer, ticket.id, recipient);
    await expect(cancelTransfer(db, recipient, first.transferId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await cancelTransfer(db, buyer, first.transferId);
    await expect(acceptTransfer(db, recipient, first.token)).rejects.toMatchObject({ code: "INVALID_STATE" });

    const second = await request(buyer, ticket.id, recipient);
    await declineTransfer(db, recipient, second.token);
    expect(await db.ticketTransfer.findUniqueOrThrow({ where: { id: second.transferId } })).toMatchObject({ status: "CANCELLED", decidedById: recipient.id, decisionReason: "Recusada pelo destinatário" });
    await expect(acceptTransfer(db, recipient, second.token)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } })).holderUserId).toBe(buyer.id);
  });

  it("respeita o limite por conta do evento (contrato a)", async () => {
    const { buyer, recipient, ticket, event } = await setup();
    await buyAndPay(recipient, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    await db.event.update({ where: { id: event.id }, data: { maxTicketsPerAccount: 2 } });
    const { token } = await request(buyer, ticket.id, recipient);
    await expect(acceptTransfer(db, recipient, token)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await db.event.update({ where: { id: event.id }, data: { maxTicketsPerAccount: 3 } });
    await acceptTransfer(db, recipient, token);
  });

  it(`limite de ${TRANSFER_POLICY.maxTransfersPerTicket} transferências aceitas por ingresso`, async () => {
    const { buyer, ticket } = await setup();
    let holder = buyer;
    for (let i = 0; i < TRANSFER_POLICY.maxTransfersPerTicket; i++) {
      const next = await makeUser();
      const { token } = await request(holder, ticket.id, next);
      await acceptTransfer(db, next, token);
      holder = next;
    }
    await expect(request(holder, ticket.id, buyer)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const mine = await listMyTransfers(db, holder);
    expect(mine.received.map((t) => t.status)).toEqual(["ACCEPTED"]);
  });
});

describe("T-TRANSF — concorrência", () => {
  it("aceite × check-in com o QR antigo: nunca admitem o QR antigo e o novo", async () => {
    for (let round = 0; round < 6; round++) {
      await resetDb();
      const { owner, buyer, recipient, ticket, event } = await setup();
      const oldPayload = qrPayload(ticket);
      const { token } = await request(buyer, ticket.id, recipient);
      const [scan, accept] = await Promise.allSettled([checkInTicket(db, owner, event.id, oldPayload), acceptTransfer(db, recipient, token)]);
      const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      const newScan = await checkInTicket(db, owner, event.id, qrPayload(after));
      const admitted = [scan.status === "fulfilled" && scan.value.result === "ADMITTED", newScan.result === "ADMITTED"].filter(Boolean);
      expect(admitted).toHaveLength(1);
      if (accept.status === "fulfilled") {
        // O aceite venceu: o QR antigo não pode ter admitido.
        expect(scan.status === "fulfilled" && scan.value.result).toBe("INVALID");
        expect(after.holderUserId).toBe(recipient.id);
      } else {
        expect(scan.status === "fulfilled" && scan.value.result).toBe("ADMITTED");
        expect(after.holderUserId).toBe(buyer.id);
        expect(newScan.result).toBe("DUPLICATE");
      }
      expect(await db.ticketCheckin.count({ where: { result: "ADMITTED" } })).toBe(1);
    }
  });

  it("aceite × pedido de reembolso: ingresso reembolsado nunca admite (nem QR antigo nem novo)", async () => {
    for (let round = 0; round < 6; round++) {
      await resetDb();
      const { owner, buyer, recipient, ticket, event, order } = await setup();
      const { token } = await request(buyer, ticket.id, recipient);
      const [accept, refund] = await Promise.allSettled([acceptTransfer(db, recipient, token), requestCustomerRefund(db, adapter, buyer, order.id)]);
      const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      const finalOrder = await db.order.findUniqueOrThrow({ where: { id: order.id } });
      if (refund.status === "fulfilled") {
        // Reembolso (ao pagador original, D7) revoga o ingresso, mesmo transferido.
        expect(["REFUND_PENDING", "REFUNDED"]).toContain(finalOrder.status);
        expect(after.status).toBe("REVOKED");
      } else {
        // Regra futura do financeiro (bloquear reembolso de transferido) também é aceitável.
        expect(accept.status).toBe("fulfilled");
        expect(finalOrder.status).toBe("PAID");
      }
      if (accept.status === "rejected") expect(after.holderUserId).toBe(buyer.id);
      for (const payload of [qrPayload(ticket), qrPayload(after)]) {
        const r = await checkInTicket(db, owner, event.id, payload);
        if (after.status === "REVOKED") expect(r.result).not.toBe("ADMITTED");
      }
      expect(await db.ticketCheckin.count({ where: { result: "ADMITTED" } })).toBe(after.status === "REVOKED" ? 0 : 1);
    }
  });

  it("dois aceites simultâneos para a mesma conta não furam o limite por conta", async () => {
    const owner = await makeUser();
    const event = await makeEvent(await makeOrg(owner));
    await db.event.update({ where: { id: event.id }, data: { maxTicketsPerAccount: 1 } });
    const recipient = await makeUser();
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const seller = await makeUser();
      const { order } = await buyAndPay(seller, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
      const t = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
      tokens.push((await request(seller, t.id, recipient)).token);
    }
    const results = await Promise.allSettled(tokens.map((tk) => acceptTransfer(db, recipient, tk)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.issuedTicket.count({ where: { eventId: event.id, holderUserId: recipient.id } })).toBe(1);
  });
});

describe("T-TRANSF — histórico imutável", () => {
  it("transferência decidida não pode ser alterada nem apagada", async () => {
    const { buyer, recipient, ticket } = await setup();
    const { token, transferId } = await request(buyer, ticket.id, recipient);
    await acceptTransfer(db, recipient, token);
    await expect(db.ticketTransfer.update({ where: { id: transferId }, data: { decisionReason: "editado" } })).rejects.toThrow(/imutável/);
    await expect(db.$executeRaw`UPDATE "TicketTransfer" SET "toEmail" = 'outro@test.local' WHERE id = ${transferId}`).rejects.toThrow();
    await expect(db.ticketTransfer.delete({ where: { id: transferId } })).rejects.toThrow(/DELETE bloqueado/);
    // Pendente: os dados do pedido também não mudam.
    const pending = await request(recipient, ticket.id, buyer);
    await expect(db.ticketTransfer.update({ where: { id: pending.transferId }, data: { toEmail: "x@test.local" } })).rejects.toThrow();
    expect(await db.ticketTransfer.count({ where: { ticketId: ticket.id } })).toBe(2);
  });
});
