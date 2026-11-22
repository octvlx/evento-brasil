// QR rotativo do Google Wallet (EB3) na portaria: entra no momento certo; print antigo,
// código errado e QR de antes da transferência não entram.
import { beforeEach, describe, expect, it } from "vitest";
import { deriveWalletTotpKey, totpCode } from "@/server/crypto";
import { checkInTicket } from "@/server/services/checkin";
import { acceptTransfer, requestTransfer } from "@/server/services/transfers";
import { qrStep } from "@/lib/qr-payload";
import { buyAndPay, db, makeEvent, makeOrg, makeVerifiedUser as makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

/** O que o Google mostraria no passe no instante `at`. */
function walletQr(t: { code: string; tokenVersion: number }, at = new Date()) {
  const step = qrStep(at.getTime());
  return `EB3:${t.code}:${step * 30}:${totpCode(deriveWalletTotpKey(t.code, t.tokenVersion), step, 8)}`;
}

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { startsInDays: 5 });
  const customer = await makeUser();
  const { order } = await buyAndPay(customer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { code: "asc" } });
  return { owner, event, customer, tickets };
}

describe("QR do Google Wallet (EB3)", () => {
  it("entra com o código do momento; o mesmo QR de novo é JÁ UTILIZADO", async () => {
    const { owner, event, tickets } = await setup();
    const qr = walletQr(tickets[0]);
    expect((await checkInTicket(db, owner, event.id, qr)).result).toBe("ADMITTED");
    expect((await checkInTicket(db, owner, event.id, qr)).result).toBe("DUPLICATE");
  });

  it("print antigo: EXPIRADO; código adulterado: inválido", async () => {
    const { owner, event, tickets } = await setup();
    const old = walletQr(tickets[0], new Date(Date.now() - 5 * 60_000));
    expect(await checkInTicket(db, owner, event.id, old)).toMatchObject({ result: "INVALID", message: expect.stringMatching(/EXPIRADO/) });
    const good = walletQr(tickets[1]);
    const digits = good.slice(-8);
    const forged = good.slice(0, -8) + (digits === "00000000" ? "00000001" : "00000000");
    expect((await checkInTicket(db, owner, event.id, forged)).result).toBe("INVALID");
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[1].id } })).status).toBe("VALID");
  });

  it("passe de antes da transferência: QR SUBSTITUÍDO; o do novo titular entra", async () => {
    const { owner, event, customer, tickets } = await setup();
    const friend = await makeUser();
    const before = walletQr(tickets[0]);
    const transfer = await requestTransfer(db, customer, tickets[0].id, { toEmail: friend.email, toName: friend.name });
    await acceptTransfer(db, friend, transfer.token);
    const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } });
    expect(await checkInTicket(db, owner, event.id, before)).toMatchObject({ result: "INVALID", message: expect.stringMatching(/SUBSTITUÍDO/) });
    expect((await checkInTicket(db, owner, event.id, walletQr(after))).result).toBe("ADMITTED");
  });
});
