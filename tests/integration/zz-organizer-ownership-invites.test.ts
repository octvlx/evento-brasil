// Organizador (item 17): limite de convites pendentes e transferência de responsável
// com aceite do novo dono.
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "@/server/auth/password";
import { hashToken } from "@/server/crypto";
import {
  acceptOwnershipTransfer,
  assignStaffToEvent,
  cancelOwnershipTransfer,
  changeMemberRole,
  declineOwnershipTransfer,
  getOwnershipTransferForRecipient,
  inviteMember,
  MAX_PENDING_INVITATIONS,
  OWNERSHIP_TRANSFER_TTL_MS,
  pendingOwnershipTransfer,
  removeMember,
  requestOwnershipTransfer,
  revokeInvitation,
} from "@/server/services/organizers";
import { db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const PASSWORD = "Senha-de-teste-123";

async function team() {
  const owner = await makeUser();
  await db.user.update({ where: { id: owner.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
  const admin = await makeUser();
  const staff = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: admin.id, role: "ADMIN" }, { userId: staff.id, role: "CHECKIN_STAFF" }] });
  return { owner, admin, staff, org };
}

const role = async (organizationId: string, userId: string) =>
  (await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } }))?.role;

describe("convites: limites", () => {
  it("um convite ativo por e-mail; vencido ou revogado não bloqueia", async () => {
    const { owner, org } = await team();
    const { invitation } = await inviteMember(db, owner, org.id, { email: "nova@exemplo.test", role: "EVENT_MANAGER" });
    await expect(inviteMember(db, owner, org.id, { email: "nova@exemplo.test", role: "FINANCE" })).rejects.toMatchObject({ code: "CONFLICT" });
    await db.organizationInvitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const second = await inviteMember(db, owner, org.id, { email: "nova@exemplo.test", role: "FINANCE" });
    await revokeInvitation(db, owner, org.id, second.invitation.id);
    await expect(inviteMember(db, owner, org.id, { email: "nova@exemplo.test", role: "FINANCE" })).resolves.toBeTruthy();
  });

  it(`no máximo ${MAX_PENDING_INVITATIONS} convites ativos; revogar libera vaga`, async () => {
    const { owner, org } = await team();
    await db.organizationInvitation.createMany({
      data: Array.from({ length: MAX_PENDING_INVITATIONS }, (_, i) => ({
        organizationId: org.id,
        email: `c${i}@exemplo.test`,
        role: "FINANCE" as const,
        tokenHash: hashToken(`tok-${i}`),
        invitedById: owner.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    });
    await expect(inviteMember(db, owner, org.id, { email: "mais@exemplo.test", role: "FINANCE" })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    const one = await db.organizationInvitation.findFirstOrThrow({ where: { organizationId: org.id } });
    await revokeInvitation(db, owner, org.id, one.id);
    await expect(inviteMember(db, owner, org.id, { email: "mais@exemplo.test", role: "FINANCE" })).resolves.toBeTruthy();
  });
});

describe("transferência de responsável", () => {
  it("pedido: só o OWNER, com a senha, para outro membro que ainda não é OWNER", async () => {
    const { owner, admin, staff, org } = await team();
    await expect(requestOwnershipTransfer(db, admin, org.id, staff.id, undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requestOwnershipTransfer(db, owner, org.id, admin.id, "errada")).rejects.toMatchObject({ code: "FORBIDDEN", message: "Senha incorreta." });
    await expect(requestOwnershipTransfer(db, owner, org.id, admin.id, undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requestOwnershipTransfer(db, owner, org.id, owner.id, PASSWORD)).rejects.toMatchObject({ code: "VALIDATION" });
    const outsider = await makeUser();
    await expect(requestOwnershipTransfer(db, owner, org.id, outsider.id, PASSWORD)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Nada mudou e nada ficou pendente.
    expect(await pendingOwnershipTransfer(db, owner, org.id)).toBeNull();
    expect(await role(org.id, owner.id)).toBe("OWNER");
  });

  it("aceite: o novo dono vira OWNER, o anterior vira ADMIN; auditoria e e-mails para os dois", async () => {
    const { owner, staff, org } = await team();
    const event = await makeEvent(org);
    await assignStaffToEvent(db, owner, event.id, staff.id, true);
    const { token, transfer } = await requestOwnershipTransfer(db, owner, org.id, staff.id, PASSWORD);
    expect(await db.emailOutbox.count({ where: { dedupeKey: `ownership:${transfer.id}`, recipient: staff.email } })).toBe(1);
    expect(await pendingOwnershipTransfer(db, owner, org.id)).toMatchObject({ toEmail: staff.email });
    // Até o aceite, nada muda.
    expect(await role(org.id, staff.id)).toBe("CHECKIN_STAFF");

    const other = await makeUser();
    expect(await getOwnershipTransferForRecipient(db, other, token)).toEqual({ forMe: false });
    await expect(acceptOwnershipTransfer(db, other, token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getOwnershipTransferForRecipient(db, staff, token)).toMatchObject({ forMe: true });

    await acceptOwnershipTransfer(db, staff, token);
    expect(await role(org.id, staff.id)).toBe("OWNER");
    expect(await role(org.id, owner.id)).toBe("ADMIN");
    // Atribuições de portaria não valem mais para quem deixou de ser CHECKIN_STAFF.
    expect(await db.eventStaffAssignment.count({ where: { userId: staff.id } })).toBe(0);
    expect(await db.auditLog.findFirst({ where: { action: "organization.ownership_transferred", entityId: transfer.id } })).toMatchObject({
      actorUserId: staff.id,
      metadata: { fromUserId: owner.id, toUserId: staff.id, previousRole: "CHECKIN_STAFF" },
    });
    expect(await db.emailOutbox.count({ where: { template: "ORGANIZATION_OWNERSHIP_CHANGED" } })).toBe(2);
    // O link não serve de novo.
    await expect(acceptOwnershipTransfer(db, staff, token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getOwnershipTransferForRecipient(db, staff, token)).toBeNull();
  });

  it("novo pedido cancela o anterior; recusa e cancelamento não mudam papéis", async () => {
    const { owner, admin, staff, org } = await team();
    const first = await requestOwnershipTransfer(db, owner, org.id, admin.id, PASSWORD);
    const second = await requestOwnershipTransfer(db, owner, org.id, staff.id, PASSWORD);
    expect((await db.organizationOwnershipTransfer.findUniqueOrThrow({ where: { id: first.transfer.id } })).status).toBe("CANCELLED");
    await expect(acceptOwnershipTransfer(db, admin, first.token)).rejects.toMatchObject({ code: "NOT_FOUND" });

    await declineOwnershipTransfer(db, staff, second.token);
    expect((await db.organizationOwnershipTransfer.findUniqueOrThrow({ where: { id: second.transfer.id } })).status).toBe("DECLINED");

    const third = await requestOwnershipTransfer(db, owner, org.id, admin.id, PASSWORD);
    await expect(cancelOwnershipTransfer(db, admin, org.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await cancelOwnershipTransfer(db, owner, org.id);
    await expect(acceptOwnershipTransfer(db, admin, third.token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect([await role(org.id, owner.id), await role(org.id, admin.id), await role(org.id, staff.id)]).toEqual(["OWNER", "ADMIN", "CHECKIN_STAFF"]);
  });

  it("pedido vencido ou equipe alterada depois do pedido não transfere", async () => {
    const { owner, admin, staff, org } = await team();
    const later = new Date(Date.now() + OWNERSHIP_TRANSFER_TTL_MS + 1000);
    const a = await requestOwnershipTransfer(db, owner, org.id, admin.id, PASSWORD);
    await expect(acceptOwnershipTransfer(db, admin, a.token, later)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Destinatário saiu da equipe.
    const b = await requestOwnershipTransfer(db, owner, org.id, staff.id, PASSWORD);
    await removeMember(db, owner, org.id, staff.id);
    await expect(acceptOwnershipTransfer(db, staff, b.token)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await role(org.id, owner.id)).toBe("OWNER");

    // Quem pediu deixou de ser OWNER (outro dono o rebaixou).
    await changeMemberRole(db, owner, org.id, admin.id, "OWNER");
    const c = await requestOwnershipTransfer(db, owner, org.id, (await makeMember(org.id)).id, PASSWORD);
    await changeMemberRole(db, admin, org.id, owner.id, "ADMIN");
    const target = await db.organizationOwnershipTransfer.findFirstOrThrow({ where: { id: c.transfer.id } });
    await expect(acceptOwnershipTransfer(db, { id: target.toUserId, status: "ACTIVE" } as never, c.token)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("dois aceites ao mesmo tempo: um só transfere", async () => {
    const { owner, admin, org } = await team();
    const { token } = await requestOwnershipTransfer(db, owner, org.id, admin.id, PASSWORD);
    const results = await Promise.allSettled([acceptOwnershipTransfer(db, admin, token), acceptOwnershipTransfer(db, admin, token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "organization.ownership_transferred" } })).toBe(1);
    expect(await role(org.id, admin.id)).toBe("OWNER");
  });
});

async function makeMember(organizationId: string) {
  const u = await makeUser();
  await db.organizationMember.create({ data: { organizationId, userId: u.id, role: "EVENT_MANAGER" } });
  return u;
}
