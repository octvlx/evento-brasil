// Fila de e-mails: e-mail com link que deixou de valer não sai (convite reenviado ou
// revogado; transferência de responsável substituída, cancelada ou recusada) e uma
// falha no provedor não afeta o convite (fica para as retentativas).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelQueuedEmails, dispatchEmailOutbox, enqueueEmail } from "@/server/email/outbox";
import { EmailDeliveryError, type EmailAdapter } from "@/server/email";
import { hashPassword } from "@/server/auth/password";
import {
  cancelOwnershipTransfer,
  declineOwnershipTransfer,
  inviteMember,
  requestOwnershipTransfer,
  resendInvitation,
  revokeInvitation,
} from "@/server/services/organizers";
import { db, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const PASSWORD = "Senha-de-teste-123";
const capture = () => {
  const sent: { to: string; text: string }[] = [];
  const adapter: EmailAdapter = { id: "fake", send: vi.fn(async (m) => void sent.push({ to: m.to, text: m.text ?? "" })) };
  return { adapter, sent };
};
const statusOf = async (prefix: string) =>
  (await db.emailOutbox.findMany({ where: { dedupeKey: { startsWith: prefix } }, orderBy: { createdAt: "asc" }, select: { status: true, errorCode: true, messageEncrypted: true } })).map((r) => [
    r.status,
    r.errorCode,
    r.messageEncrypted === null,
  ]);

async function team() {
  const owner = await makeUser();
  await db.user.update({ where: { id: owner.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
  const a = await makeUser();
  const b = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: a.id, role: "ADMIN" }, { userId: b.id, role: "FINANCE" }] });
  return { owner, a, b, org };
}

describe("convite da equipe", () => {
  it("um e-mail por convite, pela fila; o link enviado é o do convite", async () => {
    const { owner, org } = await team();
    const { invitation, token } = await inviteMember(db, owner, org.id, { email: "nova@exemplo.test", role: "EVENT_MANAGER" });
    expect(await db.emailOutbox.count({ where: { template: "ORGANIZER_INVITATION" } })).toBe(1);
    const { adapter, sent } = capture();
    await dispatchEmailOutbox(db, { adapter });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(invitation.email);
    expect(sent[0].text).toContain(`/convite/${token}`);
  });

  it("falha no provedor não desfaz o convite: o e-mail volta para a fila e sai depois", async () => {
    const { owner, org } = await team();
    const { invitation } = await inviteMember(db, owner, org.id, { email: "nova@exemplo.test", role: "EVENT_MANAGER" });
    const failing: EmailAdapter = {
      id: "fake",
      send: vi.fn(async () => {
        throw new EmailDeliveryError("PROVIDER_UNAVAILABLE", true);
      }),
    };
    await dispatchEmailOutbox(db, { adapter: failing });
    expect(await db.organizationInvitation.findUnique({ where: { id: invitation.id } })).toMatchObject({ revokedAt: null, acceptedAt: null });
    const job = await db.emailOutbox.findFirstOrThrow({ where: { template: "ORGANIZER_INVITATION" } });
    expect(job.status).toBe("QUEUED");
    await db.emailOutbox.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const { adapter, sent } = capture();
    await dispatchEmailOutbox(db, { adapter });
    expect(sent).toHaveLength(1);
  });

  it("reenviar: só o link novo sai; revogar: nada sai", async () => {
    const { owner, org } = await team();
    const { invitation } = await inviteMember(db, owner, org.id, { email: "nova@exemplo.test", role: "EVENT_MANAGER" });
    const { token } = await resendInvitation(db, owner, org.id, invitation.id);
    expect(await statusOf("invitation:" + invitation.id)).toEqual([
      ["CANCELLED", "INVITATION_SUPERSEDED", true],
      ["QUEUED", null, false],
    ]);
    const { adapter, sent } = capture();
    await dispatchEmailOutbox(db, { adapter });
    expect(sent.map((s) => s.text.includes(`/convite/${token}`))).toEqual([true]);

    const other = await inviteMember(db, owner, org.id, { email: "outra@exemplo.test", role: "FINANCE" });
    await revokeInvitation(db, owner, org.id, other.invitation.id);
    expect(await statusOf("invitation:" + other.invitation.id)).toEqual([["CANCELLED", "INVITATION_REVOKED", true]]);
    await dispatchEmailOutbox(db, { adapter });
    expect(sent).toHaveLength(1);
  });

  it("e-mail já enviado não é tocado", async () => {
    await enqueueEmail(db, { dedupeKey: "invitation:xyz", template: "ORGANIZER_INVITATION", recipient: "x@exemplo.test", message: { subject: "s", html: "<p>h</p>", text: "t" } });
    await dispatchEmailOutbox(db, { adapter: capture().adapter });
    expect(await cancelQueuedEmails(db, { prefix: "invitation:xyz" }, "TESTE")).toBe(0);
    expect((await db.emailOutbox.findFirstOrThrow({ where: { dedupeKey: "invitation:xyz" } })).status).toBe("SENT");
    expect(await cancelQueuedEmails(db, [], "TESTE")).toBe(0);
  });
});

describe("transferência de responsável", () => {
  it("pedido substituído, cancelado ou recusado: o e-mail pendente não sai", async () => {
    const { owner, a, b, org } = await team();
    const first = await requestOwnershipTransfer(db, owner, org.id, a.id, PASSWORD);
    const second = await requestOwnershipTransfer(db, owner, org.id, b.id, PASSWORD);
    expect(await statusOf("ownership:" + first.transfer.id)).toEqual([["CANCELLED", "OWNERSHIP_TRANSFER_SUPERSEDED", true]]);
    expect(await statusOf("ownership:" + second.transfer.id)).toEqual([["QUEUED", null, false]]);

    await cancelOwnershipTransfer(db, owner, org.id);
    expect(await statusOf("ownership:" + second.transfer.id)).toEqual([["CANCELLED", "OWNERSHIP_TRANSFER_CANCELLED", true]]);

    const third = await requestOwnershipTransfer(db, owner, org.id, a.id, PASSWORD);
    await declineOwnershipTransfer(db, a, third.token);
    expect(await statusOf("ownership:" + third.transfer.id)).toEqual([["CANCELLED", "OWNERSHIP_TRANSFER_DECLINED", true]]);

    const { adapter, sent } = capture();
    await dispatchEmailOutbox(db, { adapter });
    expect(sent).toHaveLength(0);
  });
});
