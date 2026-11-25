// QR rotativo do Google Wallet (EB3) na portaria: entra no momento certo; print antigo,
// código errado e QR de antes da transferência não entram.
import { beforeEach, describe, expect, it } from "vitest";
import { deriveWalletTotpKey, totpCode } from "@/server/crypto";
import { checkInTicket, WALLET_TOTP_LIMIT, WALLET_TOTP_LOCKED_AUDIT } from "@/server/services/checkin";
import { securityAlerts } from "@/server/services/security-alerts";
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

  it("muitos códigos errados travam o QR da carteira daquele ingresso (até o certo); os outros ingressos seguem", async () => {
    const { owner, event, tickets } = await setup();
    const good = walletQr(tickets[0]);
    const wrong = (i: number) => {
      const digits = String(i).padStart(8, "0");
      return good.slice(0, -8) + (digits === good.slice(-8) ? "99999999" : digits);
    };
    for (let i = 0; i < WALLET_TOTP_LIMIT.max - 1; i++) expect((await checkInTicket(db, owner, event.id, wrong(i))).result).toBe("INVALID");
    expect(await db.auditLog.count({ where: { action: WALLET_TOTP_LOCKED_AUDIT } })).toBe(0);
    expect(await checkInTicket(db, owner, event.id, wrong(WALLET_TOTP_LIMIT.max))).toMatchObject({ result: "INVALID" });

    const locks = await db.auditLog.findMany({ where: { action: WALLET_TOTP_LOCKED_AUDIT } });
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ entityType: "IssuedTicket", entityId: tickets[0].id, actorUserId: owner.id });
    expect((await securityAlerts(db)).map((c) => c.code)).toEqual(["WALLET_TOTP_LOCKED"]);

    // Travado: nem o código certo entra, e mais erros não duplicam a auditoria.
    expect(await checkInTicket(db, owner, event.id, good)).toMatchObject({ result: "INVALID", message: expect.stringMatching(/CARTEIRA BLOQUEADO/) });
    await checkInTicket(db, owner, event.id, wrong(1));
    expect(await db.auditLog.count({ where: { action: WALLET_TOTP_LOCKED_AUDIT } })).toBe(1);
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[0].id } })).status).toBe("VALID");

    // Outro ingresso do mesmo pedido não é afetado.
    expect((await checkInTicket(db, owner, event.id, walletQr(tickets[1]))).result).toBe("ADMITTED");
    // Passada a janela, o QR da carteira volta a valer.
    const later = new Date(Date.now() + WALLET_TOTP_LIMIT.windowMs + 60_000);
    expect((await checkInTicket(db, owner, event.id, walletQr(tickets[0], later), later)).result).toBe("ADMITTED");
  });
});
