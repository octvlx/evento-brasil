import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { acceptTransfer, declineTransfer, listMyTransfers, requestTransfer } from "@/server/services/transfers";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, makeVerifiedUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function pendingBeforeSignup() {
  const owner = await makeVerifiedUser();
  const event = await makeEvent(await makeOrg(owner));
  const sender = await makeVerifiedUser();
  const { order } = await buyAndPay(sender, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
  const email = `recipient-${randomUUID()}@test.local`;
  const invite = await requestTransfer(db, sender, ticket.id, { toEmail: email, toName: "Destinatário" });
  const recipient = await makeUser({ email });
  return { sender, ticket, invite, recipient };
}

describe("transfer recipient mailbox ownership", () => {
  it.each(["id", "token"] as const)("blocks an unverified recipient via %s, then accepts after actual email verification", async (kind) => {
    const { sender, ticket, invite, recipient } = await pendingBeforeSignup();
    const ref = kind === "id" ? { transferId: invite.transferId } : invite.token;
    // Deliberately unverified account; merely registering the addressed email is not proof.
    expect(recipient.emailVerifiedAt).toBeNull();
    expect((await listMyTransfers(db, recipient)).received).toEqual([]);
    await expect(acceptTransfer(db, recipient, ref)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(declineTransfer(db, recipient, ref)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.ticketTransfer.findUniqueOrThrow({ where: { id: invite.transferId } })).toMatchObject({ status: "PENDING" });
    expect(await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ holderUserId: sender.id, validationToken: ticket.validationToken });

    await db.user.update({ where: { id: recipient.id }, data: { emailVerifiedAt: new Date() } });
    // Use the same stale actor object: authorization must read the database, not trust caller flags.
    expect((await listMyTransfers(db, recipient)).received.map(t => t.id)).toEqual([invite.transferId]);
    await expect(acceptTransfer(db, recipient, ref)).resolves.toMatchObject({ ticketCode: ticket.code });
    const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.holderUserId).toBe(recipient.id);
    expect(after.validationToken).not.toBe(ticket.validationToken);
  });

  it("allows verified recipients to decline by ID", async () => {
    const { sender, ticket, invite, recipient } = await pendingBeforeSignup();
    await db.user.update({ where: { id: recipient.id }, data: { emailVerifiedAt: new Date() } });
    await declineTransfer(db, recipient, { transferId: invite.transferId });
    expect(await db.ticketTransfer.findUniqueOrThrow({ where: { id: invite.transferId } })).toMatchObject({ status: "CANCELLED" });
    expect(await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ holderUserId: sender.id });
  });
});
