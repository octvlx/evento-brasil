// Token do QR fora do banco: HMAC(QR_TOKEN_SECRET, código, versão) recalculado; o banco
// guarda só o SHA-256. Ingressos anteriores (versão 0) mantêm o QR já enviado.
import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { checkInTicket, checkinOfflinePackage } from "@/server/services/checkin";
import { loadPdfTickets } from "@/server/services/notifications";
import { qrPayload, ticketQrToken } from "@/server/services/tickets";
import { acceptTransfer, requestTransfer } from "@/server/services/transfers";
import { buyAndPay, db, makeEvent, makeOrg, makeVerifiedUser as makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function setup(quantity = 2) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity }]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
  return { owner, event, buyer, order, tickets };
}

/** Converte o ingresso para o formato anterior à mudança, como a migração deixa os existentes. */
async function makeLegacy(ticketId: string) {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    ticket: await db.issuedTicket.update({ where: { id: ticketId }, data: { tokenVersion: 0, legacyValidationToken: token, validationTokenHash: sha256(token) } }),
  };
}

describe("token do QR fora do banco", () => {
  it("ingresso novo: nenhuma coluna guarda o token; o QR recalculado admite uma vez", async () => {
    const { owner, event, tickets } = await setup();
    const t = tickets[0];
    const token = ticketQrToken(t)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t).toMatchObject({ tokenVersion: 1, legacyValidationToken: null, validationTokenHash: sha256(token) });
    // Nenhum valor da linha é o token.
    const [raw] = await db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM "IssuedTicket" WHERE id = ${t.id}`;
    expect(JSON.stringify(raw)).not.toContain(token);

    expect((await checkInTicket(db, owner, event.id, qrPayload(t))).result).toBe("ADMITTED");
    expect((await checkInTicket(db, owner, event.id, qrPayload(t))).result).toBe("DUPLICATE");
  });

  it("o hash do banco não serve de QR, e o token de um ingresso não abre outro", async () => {
    const { owner, event, tickets } = await setup();
    const [a, b] = tickets;
    expect((await checkInTicket(db, owner, event.id, `EB1:${a.code}:${a.validationTokenHash.slice(0, 43)}`)).result).toBe("INVALID");
    expect((await checkInTicket(db, owner, event.id, qrPayload({ code: b.code, validationToken: ticketQrToken(a)! }))).result).toBe("INVALID");
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("VALID");
  });

  it("ingresso anterior (versão 0): o QR já enviado continua valendo e o check-in apaga o token antigo", async () => {
    const { owner, event, order, tickets } = await setup();
    const { token, ticket } = await makeLegacy(tickets[0].id);
    expect(ticketQrToken(ticket)).toBe(token);
    expect((await loadPdfTickets(db, { orderId: order.id })).map((p) => p.validationToken)).toContain(token);

    expect((await checkInTicket(db, owner, event.id, `EB1:${ticket.code}:${token}`)).result).toBe("ADMITTED");
    const used = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(used).toMatchObject({ status: "CHECKED_IN", legacyValidationToken: null, validationTokenHash: sha256(token) });
    // Sem token, não há QR para remontar: fica fora do PDF; a portaria ainda reconhece a duplicidade.
    expect((await loadPdfTickets(db, { orderId: order.id })).map((p) => p.code)).toEqual([tickets[1].code]);
    expect((await checkInTicket(db, owner, event.id, `EB1:${ticket.code}:${token}`)).result).toBe("DUPLICATE");
  });

  it("transferência de ingresso anterior: passa à versão 1, apaga o token antigo e o QR antigo para de valer", async () => {
    const { owner, event, buyer, tickets } = await setup(1);
    const { token: oldToken, ticket } = await makeLegacy(tickets[0].id);
    const recipient = await makeUser();
    const { token } = await requestTransfer(db, buyer, ticket.id, { toEmail: recipient.email, toName: "Nova Titular" }, { ip: "203.0.113.9", userAgent: "vitest" });
    await acceptTransfer(db, recipient, token, { ip: "198.51.100.1", userAgent: "vitest" });

    const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after).toMatchObject({ tokenVersion: 1, legacyValidationToken: null, validationTokenHash: sha256(ticketQrToken(after)!) });
    const old = await checkInTicket(db, owner, event.id, `EB1:${ticket.code}:${oldToken}`);
    expect(old).toMatchObject({ result: "INVALID", ticket: { qrReplaced: true } });
    expect((await checkInTicket(db, owner, event.id, qrPayload(after))).result).toBe("ADMITTED");
  });

  it("lista offline: leva o hash do banco, nunca o token", async () => {
    const { owner, event, tickets } = await setup();
    const pkg = await checkinOfflinePackage(db, owner, event.id);
    const json = JSON.stringify(pkg);
    for (const t of tickets) {
      expect(json).toContain(t.validationTokenHash);
      expect(json).not.toContain(ticketQrToken(t)!);
    }
  });
});
