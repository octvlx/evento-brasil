// QR dinâmico na portaria: print/foto (passo antigo) e QR fixo do PDF/carteira não entram;
// QR de antes de uma transferência aparece como substituído; lista offline só com chave pública.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkInTicket, checkinOfflinePackage } from "@/server/services/checkin";
import { qrPayload } from "@/server/services/tickets";
import { acceptTransfer, requestTransfer } from "@/server/services/transfers";
import { QR_STEP_MS, QR_STEP_TOLERANCE } from "@/lib/qr-payload";
import { buyAndPay, db, gateQr, makeEvent, makeOrg, makeVerifiedUser as makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.QR_STATIC_ACCEPTED;
});

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { startsInDays: 5 });
  const customer = await makeUser();
  const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { code: "asc" } });
  return { owner, event, customer, tickets };
}

describe("QR dinâmico na portaria", () => {
  it("print de agora há pouco entra; print antigo (fora da tolerância) é recusado como expirado", async () => {
    const { owner, event, tickets } = await setup();
    const now = new Date();
    // Dentro da tolerância (atraso de leitura, relógio um pouco diferente): entra.
    const recent = gateQr(tickets[0], new Date(now.getTime() - QR_STEP_TOLERANCE * QR_STEP_MS));
    expect((await checkInTicket(db, owner, event.id, recent, now)).result).toBe("ADMITTED");
    // Print de 5 minutos atrás: assinatura certa, momento errado.
    const old = gateQr(tickets[1], new Date(now.getTime() - 5 * 60_000));
    const r = await checkInTicket(db, owner, event.id, old, now);
    expect(r).toMatchObject({ result: "INVALID", message: expect.stringMatching(/EXPIRADO/) });
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[1].id } })).status).toBe("VALID");
    // A leitura recusada fica no histórico ligada ao ingresso (o organizador vê a tentativa).
    expect(await db.ticketCheckin.count({ where: { ticketId: tickets[1].id, result: "INVALID" } })).toBe(1);
  });

  it("QR fixo (PDF/carteira) é recusado por padrão; com a transição ligada, ainda entra", async () => {
    const { owner, event, tickets } = await setup();
    const refused = await checkInTicket(db, owner, event.id, qrPayload(tickets[0]));
    expect(refused).toMatchObject({ result: "INVALID", message: expect.stringMatching(/QR FIXO/) });
    process.env.QR_STATIC_ACCEPTED = "true";
    expect((await checkInTicket(db, owner, event.id, qrPayload(tickets[0]))).result).toBe("ADMITTED");
  });

  it("QR gerado antes da transferência aparece como substituído; o do novo titular entra", async () => {
    const { owner, event, customer, tickets } = await setup();
    const friend = await makeUser();
    const before = gateQr(tickets[0]);
    const transfer = await requestTransfer(db, customer, tickets[0].id, { toEmail: friend.email, toName: friend.name });
    await acceptTransfer(db, friend, transfer.token);
    const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } });
    expect(after.tokenVersion).toBeGreaterThan(tickets[0].tokenVersion);
    const old = await checkInTicket(db, owner, event.id, before);
    expect(old).toMatchObject({ result: "INVALID", message: expect.stringMatching(/SUBSTITUÍDO/), ticket: { qrReplaced: true } });
    expect((await checkInTicket(db, owner, event.id, gateQr(after))).result).toBe("ADMITTED");
  });

  it("lista offline leva a chave pública só dos válidos, nunca a privada", async () => {
    const { owner, event, tickets } = await setup();
    await checkInTicket(db, owner, event.id, gateQr(tickets[0]));
    const pkg = await checkinOfflinePackage(db, owner, event.id);
    expect(pkg.staticAccepted).toBe(false);
    const used = pkg.tickets.find((t) => t.code === tickets[0].code)!;
    const valid = pkg.tickets.find((t) => t.code === tickets[1].code)!;
    expect(used.k).toBeUndefined();
    expect(valid.k).toEqual({ x: expect.any(String), y: expect.any(String) });
    expect(JSON.stringify(pkg)).not.toMatch(/"d":/);
  });
});
