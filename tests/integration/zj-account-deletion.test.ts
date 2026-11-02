// L9b (Decreto 13.108/2026, R9; LGPD art. 16 e 18): exclusão da conta pelo titular
// e expurgo programado com os prazos provisórios de src/server/retention.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "@/server/auth/password";
import { createSession } from "@/server/auth/sessions";
import { accountDeletionBlockers, deleteOwnAccount } from "@/server/services/account-deletion";
import { runRetentionPurge } from "@/server/services/retention-purge";
import { authenticate } from "@/server/services/users";
import { REDACTED_NAME, redactedEmail } from "@/server/retention";
import { makeBuyerReady } from "../support/buyer-ready";
import { buy, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

const DAY = 86_400_000;
const PASSWORD = "senha-forte-1";

beforeEach(resetDb);

async function buyer() {
  const user = await makeBuyerReady(await makeUser());
  return db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(PASSWORD), phone: "11912345678" } });
}

async function shop() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  return { owner, org, event, items: [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }] };
}

/** Leva o evento para o passado (a compra exige vendas abertas). */
async function endEvent(eventId: string, endedAgoMs: number) {
  const endsAt = new Date(Date.now() - endedAgoMs);
  const startsAt = new Date(endsAt.getTime() - 4 * 3_600_000);
  await db.event.update({ where: { id: eventId }, data: { salesStartAt: new Date(startsAt.getTime() - 30 * DAY), salesEndAt: startsAt, startsAt, endsAt } });
}

describe("exclusão da conta pelo titular", () => {
  it("bloqueia enquanto houver pedido aberto, ingresso para evento futuro, propriedade de organização ou papel de admin", async () => {
    const { owner, event, items } = await shop();
    expect(await accountDeletionBlockers(db, owner.id)).toEqual(["ORGANIZATION_OWNER"]);
    const admin = await makeUser({ admin: true });
    expect(await accountDeletionBlockers(db, admin.id)).toEqual(["PLATFORM_ADMIN"]);

    const user = await buyer();
    await buy(user, event.id, items);
    expect(await accountDeletionBlockers(db, user.id)).toEqual(["OPEN_ORDER"]);
    await expect(deleteOwnAccount(db, user, { password: PASSWORD })).rejects.toThrow(/aguardando pagamento/);

    const other = await buyer();
    await buyAndPay(other, event.id, items);
    expect(await accountDeletionBlockers(db, other.id)).toEqual(["UPCOMING_TICKET"]);
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).anonymizedAt).toBeNull();
  });

  it("senha errada não muda nada", async () => {
    const user = await buyer();
    await expect(deleteOwnAccount(db, user, { password: "errada" })).rejects.toThrow(/Senha incorreta/);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe(user.email);
    expect(after.anonymizedAt).toBeNull();
  });

  it("anonimiza conta, pedidos e ingressos, encerra o acesso e mantém valores e auditoria", async () => {
    const { event, items } = await shop();
    const user = await buyer();
    const { order } = await buyAndPay(user, event.id, items);
    await endEvent(event.id, DAY);
    await createSession(db, user.id, "vitest");
    expect(await accountDeletionBlockers(db, user.id)).toEqual([]);

    expect(await deleteOwnAccount(db, user, { password: PASSWORD })).toEqual({ orders: 1, tickets: 1 });

    const marker = redactedEmail(user.id);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id }, include: { address: true } });
    expect(after).toMatchObject({ name: REDACTED_NAME, email: marker, phone: null, cpfEncrypted: null, cpfHash: null, cpfLast2: null, birthDate: null, googleSubject: null, emailVerifiedAt: null, status: "SUSPENDED", address: null });
    expect(after.anonymizedAt).not.toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await authenticate(db, user.email, PASSWORD, { production: false })).toBeNull();

    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(paid).toMatchObject({ buyerName: REDACTED_NAME, buyerEmail: marker, buyerPhone: null, status: "PAID", totalCents: order.totalCents });
    expect(paid.piiRedactedAt).not.toBeNull();
    const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
    expect(ticket).toMatchObject({ holderName: REDACTED_NAME, holderEmail: marker });

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "user.anonymized", entityId: user.id } });
    expect(JSON.stringify(log.metadata)).not.toContain(user.email);
    expect(await db.financialLedgerEntry.count({ where: { orderId: order.id } })).toBeGreaterThan(0);

    await expect(deleteOwnAccount(db, { ...user, status: "ACTIVE" }, { password: PASSWORD })).rejects.toThrow(/já foi excluída/);
  });

  it("conta do Google confirma digitando o e-mail", async () => {
    const user = await db.user.update({ where: { id: (await makeUser()).id }, data: { googleSubject: "google-sub-1" } });
    await expect(deleteOwnAccount(db, user, { email: "outro@test.local" })).rejects.toThrow(/Digite o e-mail/);
    await deleteOwnAccount(db, user, { email: user.email.toUpperCase() });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).googleSubject).toBeNull();
  });
});

describe("expurgo programado (prazos provisórios)", () => {
  it("apaga sessões vencidas, limpa cobrança e webhooks antigos e anonimiza pedidos de eventos encerrados há mais de 5 anos", async () => {
    const { event, items } = await shop();
    const recentShop = await shop();
    const user = await buyer();
    const { order, payment } = await buyAndPay(user, event.id, items);
    const { order: recent } = await buyAndPay(user, recentShop.event.id, recentShop.items);
    await endEvent(event.id, 6 * 365 * DAY);
    await endEvent(recentShop.event.id, 10 * DAY);

    await db.session.create({ data: { userId: user.id, tokenHash: "expired-session", expiresAt: new Date(Date.now() - 1000) } });
    await db.payment.update({ where: { id: payment.id }, data: { pixCopyPaste: "000201...", pixQrCodeBase64: "base64" } });
    await db.$executeRaw`UPDATE "Payment" SET "updatedAt" = now() - interval '2 days' WHERE id = ${payment.id}`;
    await db.paymentWebhookEvent.updateMany({ data: { receivedAt: new Date(Date.now() - 200 * DAY) } });

    const first = await runRetentionPurge(db);
    expect(first).toMatchObject({ sessions: 1, chargeData: 1, orders: 1, tickets: 1 });
    expect(first.webhookPayloads).toBeGreaterThan(0);

    const old = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(old).toMatchObject({ buyerName: REDACTED_NAME, buyerEmail: redactedEmail(user.id), status: "PAID" });
    expect((await db.order.findUniqueOrThrow({ where: { id: recent.id } })).piiRedactedAt).toBeNull();
    expect(await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ pixCopyPaste: null, pixQrCodeBase64: null, status: "PAID" });
    expect((await db.paymentWebhookEvent.findMany()).every((w) => JSON.stringify(w.payload) === "{}")).toBe(true);
    // A conta continua: o expurgo por prazo só tira os dados das compras antigas.
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).anonymizedAt).toBeNull();

    // Idempotente: a segunda passada não encontra nada.
    expect(await runRetentionPurge(db)).toMatchObject({ sessions: 0, chargeData: 0, webhookPayloads: 0, orders: 0, tickets: 0 });
  });
});
