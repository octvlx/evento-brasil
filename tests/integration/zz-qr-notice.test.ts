// Aviso único do QR dinâmico: titular atual de ingresso válido emitido antes da mudança, de
// evento que ainda vai acontecer; uma vez por pessoa e evento; repetir não duplica.
import { beforeEach, describe, expect, it } from "vitest";
import { DYNAMIC_QR_LAUNCH, dynamicQrNoticeTargets, enqueueDynamicQrNotice } from "@/server/services/qr-notice";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const before = new Date(DYNAMIC_QR_LAUNCH.getTime() - 86_400_000);

describe("aviso do QR dinâmico", () => {
  it("avisa só quem precisa, agrupado por pessoa e evento, e não duplica", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org, { startsInDays: 10 });
    const ended = await makeEvent(org, { startsInDays: 1 });
    const buyer = await makeUser();
    const late = await makeUser();
    const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    const { order: endedOrder } = await buyAndPay(buyer, ended.id, [{ ticketTypeId: ended.ticketTypes[0].id, quantity: 1 }]);
    const { order: lateOrder } = await buyAndPay(late, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    // Emitidos antes da mudança: os do comprador; o do "late" foi emitido depois (já viu o aviso novo).
    await db.issuedTicket.updateMany({ where: { orderId: { in: [order.id, endedOrder.id] } }, data: { issuedAt: before } });
    // Um dos dois ingressos do comprador foi cancelado: não conta.
    const [first] = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { code: "asc" } });
    await db.issuedTicket.update({ where: { id: first.id }, data: { status: "REVOKED", revocationReason: "ADMIN" } });
    void lateOrder;

    // Daqui a 3 dias o evento "ended" (1 dia) já terminou.
    const now = new Date(Date.now() + 3 * 86_400_000);
    const targets = await dynamicQrNoticeTargets(db, now);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ eventId: event.id, recipients: [{ userId: buyer.id, email: buyer.email, tickets: 1 }] });

    expect(await enqueueDynamicQrNotice(db, now)).toEqual({ events: 1, queued: 1 });
    await enqueueDynamicQrNotice(db, now);
    const queued = await db.emailOutbox.findMany({ where: { template: "DYNAMIC_QR_NOTICE" } });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ recipient: buyer.email, status: "QUEUED", expiresAt: event.startsAt });
  });
});
