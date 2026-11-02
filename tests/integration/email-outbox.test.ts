import { beforeEach, expect, it, vi } from "vitest";
import {
  db,
  resetDb,
  makeUser,
  makeOrg,
  makeEvent,
  buy,
  buyAndPay,
} from "../support/fixtures";
import {
  enqueueEmail,
  dispatchEmailOutbox,
  consumeEmailRateLimit,
  retryFailedEmail,
} from "@/server/email/outbox";
import { enqueueOrderEmailsTx } from "@/server/email/events";
import { EmailDeliveryError, type EmailAdapter } from "@/server/email";
import { requestCustomerRefund } from "@/server/services/refunds";
import { adapter } from "../support/fixtures";
import { cancelEvent } from "@/server/services/cancellation";
import { inviteMember, resendInvitation } from "@/server/services/organizers";
const message = {
  subject: "Teste",
  html: "<p>segredo-de-teste</p>",
  text: "segredo-de-teste",
};
const fake = () => ({
  id: "fake",
  send: vi.fn<EmailAdapter["send"]>(async () => ({ id: "provider-test" })),
});
const add = (key = "one", expiresAt?: Date) =>
  enqueueEmail(db, {
    dedupeKey: key,
    template: "TEST",
    recipient: "test@example.com",
    message,
    expiresAt,
  });
beforeEach(resetDb);
it("stores encrypted content and rolls back with the originating transaction", async () => {
  const job = await add();
  expect(job.messageEncrypted).not.toContain("segredo-de-teste");
  expect(job.messageEncrypted).toMatch(/^v1\./);
  await expect(
    db.$transaction(async (tx) => {
      await enqueueEmail(tx, {
        dedupeKey: "rollback",
        template: "TEST",
        recipient: "test@example.com",
        message,
      });
      throw Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(await db.emailOutbox.count()).toBe(1);
});
it("deduplicates events and concurrent worker claims, then purges delivered content", async () => {
  const job = await add();
  await add();
  const transport = fake();
  await Promise.all(
    Array.from({ length: 3 }, () =>
      dispatchEmailOutbox(db, { adapter: transport }),
    ),
  );
  expect(transport.send).toHaveBeenCalledTimes(1);
  expect(transport.send.mock.calls[0]).toMatchObject([
    expect.objectContaining({ text: message.text }),
    { idempotencyKey: "email/" + job.id },
  ]);
  expect(
    await db.emailOutbox.findUniqueOrThrow({ where: { id: job.id } }),
  ).toMatchObject({
    status: "SENT",
    attemptCount: 1,
    messageEncrypted: null,
    payloadEncrypted: null,
    providerMessageId: "provider-test",
  });
});
it("retries with an identical frozen payload/key and bounded attempts across restarts", async () => {
  const job = await add();
  const transport = {
    id: "fake",
    send: vi
      .fn()
      .mockRejectedValue(new EmailDeliveryError("PROVIDER_UNAVAILABLE", true)),
  };
  for (let i = 0; i < 5; i++) {
    await db.emailOutbox.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await dispatchEmailOutbox(db, { adapter: transport });
  }
  expect(transport.send).toHaveBeenCalledTimes(5);
  expect(
    new Set(transport.send.mock.calls.map((c) => c[1].idempotencyKey)).size,
  ).toBe(1);
  expect(
    await db.emailOutbox.findUniqueOrThrow({ where: { id: job.id } }),
  ).toMatchObject({
    status: "FAILED",
    attemptCount: 5,
    errorCode: "PROVIDER_UNAVAILABLE",
  });
  await dispatchEmailOutbox(db, { adapter: transport });
  expect(transport.send).toHaveBeenCalledTimes(5);
});
it("does not starve valid messages behind expired or ambiguous old leases", async () => {
  const expired = await add("expired", new Date(0));
  await db.emailOutbox.update({
    where: { id: expired.id },
    data: { createdAt: new Date(1) },
  });
  const old = await add("old");
  await db.emailOutbox.update({
    where: { id: old.id },
    data: {
      createdAt: new Date(2),
      status: "PROCESSING",
      lockedUntil: new Date(0),
      firstAttemptAt: new Date(Date.now() - 24 * 3_600_000),
    },
  });
  const healthy = await add("healthy");
  const transport = fake();
  expect(await dispatchEmailOutbox(db, { adapter: transport })).toEqual({
    sent: 1,
    failed: 0,
  });
  expect(
    await db.emailOutbox.findUniqueOrThrow({ where: { id: expired.id } }),
  ).toMatchObject({ status: "CANCELLED", messageEncrypted: null });
  expect(
    await db.emailOutbox.findUniqueOrThrow({ where: { id: old.id } }),
  ).toMatchObject({ status: "UNKNOWN" });
  expect(
    await db.emailOutbox.findUniqueOrThrow({ where: { id: healthy.id } }),
  ).toMatchObject({ status: "SENT" });
});
it("recovers a crashed worker lease and treats permanent refusal without automatic retries", async () => {
  const job = await add();
  await db.emailOutbox.update({
    where: { id: job.id },
    data: {
      status: "PROCESSING",
      lockedUntil: new Date(0),
      leaseToken: "old",
      firstAttemptAt: new Date(),
    },
  });
  const transport = {
    id: "fake",
    send: vi
      .fn()
      .mockRejectedValue(
        new EmailDeliveryError("RECIPIENT_OR_DOMAIN_UNAUTHORIZED", false),
      ),
  };
  await dispatchEmailOutbox(db, { adapter: transport });
  await dispatchEmailOutbox(db, { adapter: transport });
  expect(transport.send).toHaveBeenCalledTimes(1);
  expect(
    (await db.emailOutbox.findUniqueOrThrow({ where: { id: job.id } })).status,
  ).toBe("FAILED");
});
it("enforces durable concurrent limits without storing raw IP or mailbox values", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      consumeEmailRateLimit(db, "ip:192.0.2.15", 2, 60_000),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  expect(JSON.stringify(await db.emailRateLimit.findMany())).not.toContain(
    "192.0.2.15",
  );
});
it("queues confirmations only after authoritative payment and never duplicates existing order events", async () => {
  const event = await makeEvent(await makeOrg(await makeUser()));
  const buyer = await makeUser();
  const pending = await buy(buyer, event.id, [
    { ticketTypeId: event.ticketTypes[0].id, quantity: 1 },
  ]);
  await enqueueOrderEmailsTx(db, pending.id);
  expect(await db.emailOutbox.count()).toBe(0);
  const { order } = await buyAndPay(buyer, event.id, [
    { ticketTypeId: event.ticketTypes[0].id, quantity: 1 },
  ]);
  await enqueueOrderEmailsTx(db, order.id);
  expect(await db.emailOutbox.count()).toBe(2);
  const transport = fake();
  await dispatchEmailOutbox(db, { adapter: transport });
  expect(transport.send).toHaveBeenCalledTimes(2);
  expect(
    transport.send.mock.calls.some(
      (c) => c[0]?.attachments?.[0]?.contentType === "application/pdf",
    ),
  ).toBe(true);
  await dispatchEmailOutbox(db, { adapter: transport });
  expect(transport.send).toHaveBeenCalledTimes(2);
});
it("persists real refund, event cancellation and organizer invitation events", async () => {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [
    { ticketTypeId: event.ticketTypes[0].id, quantity: 1 },
  ]);
  await requestCustomerRefund(db, adapter, buyer, order.id);
  expect(
    await db.emailOutbox.count({ where: { template: "REFUND_CONFIRMATION" } }),
  ).toBe(1);
  await buyAndPay(await makeUser(), event.id, [
    { ticketTypeId: event.ticketTypes[0].id, quantity: 1 },
  ]);
  await cancelEvent(db, adapter, owner, event.id, "Cancelamento de teste", {
    autoRefund: false,
  });
  expect(
    await db.emailOutbox.count({ where: { template: "EVENT_CANCELLED" } }),
  ).toBe(2);
  const invitation = await inviteMember(db, owner, org.id, {
    email: "team@example.com",
    role: "EVENT_MANAGER",
  });
  await resendInvitation(db, owner, org.id, invitation.invitation.id);
  expect(
    await db.emailOutbox.count({
      where: { template: "ORGANIZER_INVITATION", status: "QUEUED" },
    }),
  ).toBe(1);
  expect(
    await db.emailOutbox.count({
      where: { template: "ORGANIZER_INVITATION", status: "CANCELLED" },
    }),
  ).toBe(1);
});

it("queues a hashed verification proof atomically with minimal signup", async () => {
  const { registerUser } = await import("@/server/services/users");
  const user = await registerUser(db, {
    name: "Pessoa Teste",
    email: "signup@test.local",
    password: "Ingresso#Forte91", confirmPassword: "Ingresso#Forte91",
    acceptTerms: true,
    acceptPrivacy: true,
  });
  expect(user.emailVerifiedAt).toBeNull();
  const proof = await db.emailVerificationToken.findFirstOrThrow({
    where: { userId: user.id },
  });
  expect(proof.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  expect(proof.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
  const job = await db.emailOutbox.findFirstOrThrow({
    where: { recipient: user.email, template: "EMAIL_VERIFICATION" },
  });
  expect(job.status).toBe("QUEUED");
  expect(job.messageEncrypted).toMatch(/^v1\./);
});
it("permits operator retry only within the original safe delivery window", async () => {
  const job = await add("manual");
  await db.emailOutbox.update({
    where: { id: job.id },
    data: { status: "FAILED", firstAttemptAt: new Date(), attemptCount: 5 },
  });
  expect((await retryFailedEmail(db, job.id)).count).toBe(1);
  const transport = fake();
  await dispatchEmailOutbox(db, { adapter: transport });
  expect(transport.send.mock.calls[0][1]).toEqual({
    idempotencyKey: "email/" + job.id,
  });
  expect(
    (await db.emailOutbox.findUniqueOrThrow({ where: { id: job.id } }))
      .attemptCount,
  ).toBe(6);
  const old = await add("manual-old");
  await db.emailOutbox.update({
    where: { id: old.id },
    data: {
      status: "FAILED",
      firstAttemptAt: new Date(Date.now() - 24 * 3_600_000),
    },
  });
  await expect(retryFailedEmail(db, old.id)).rejects.toMatchObject({
    code: "VALIDATION",
  });
});
it("commits transfer invitation and acceptance notices with ownership changes", async () => {
  const { requestTransfer, acceptTransfer } =
    await import("@/server/services/transfers");
  const event = await makeEvent(await makeOrg(await makeUser()));
  const buyer = await makeUser({ verified: true });
  const recipient = await makeUser({ verified: true });
  const { order } = await buyAndPay(buyer, event.id, [
    { ticketTypeId: event.ticketTypes[0].id, quantity: 1 },
  ]);
  const ticket = await db.issuedTicket.findFirstOrThrow({
    where: { orderId: order.id },
  });
  const transfer = await requestTransfer(db, buyer, ticket.id, {
    toEmail: recipient.email,
    toName: recipient.name,
  });
  const invite = await db.emailOutbox.findFirstOrThrow({
    where: { template: "TRANSFER_INVITATION" },
  });
  expect(invite.messageEncrypted).not.toContain(transfer.token);
  expect(invite.expiresAt).toEqual(transfer.expiresAt);
  await acceptTransfer(db, recipient, transfer.token);
  expect(
    await db.emailOutbox.count({
      where: { template: "TRANSFER_ACCEPTED", status: "QUEUED" },
    }),
  ).toBe(2);
  expect(
    (await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } }))
      .holderUserId,
  ).toBe(recipient.id);
});
