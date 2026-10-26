// Fluxo N: equipe da organização — convites (revogar, reenviar, recusar, listar)
// e alteração de papel com proteção contra escalada de privilégio e contra
// deixar a organização sem OWNER. Inclui casos de autorização negada e concorrência.
import { beforeEach, describe, expect, it } from "vitest";
import type { OrgRole } from "@/generated/prisma/client";
import {
  acceptInvitation,
  changeMemberRole,
  declineInvitation,
  getInvitationForInvitee,
  inviteMember,
  listPendingInvitations,
  removeMember,
  resendInvitation,
  revokeInvitation,
} from "@/server/services/organizers";
import { db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const forbidden = { code: "FORBIDDEN" };
const invalid = { code: "NOT_FOUND" };

async function teamOrg(extra: { role: OrgRole }[] = []) {
  const owner = await makeUser();
  const others = await Promise.all(extra.map(() => makeUser()));
  const org = await makeOrg(owner, { extraMembers: others.map((u, i) => ({ userId: u.id, role: extra[i].role })) });
  return { owner, others, org };
}

const roleOf = async (organizationId: string, userId: string) =>
  (await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } }))?.role ?? null;

const auditActions = (entityId: string) =>
  db.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } }).then((rows) => rows.map((r) => r.action));

describe("N — convites da equipe", () => {
  it("revogar invalida o link e é auditado; revogar de novo é recusado", async () => {
    const { owner, org } = await teamOrg();
    const invitee = await makeUser();
    const { invitation, token } = await inviteMember(db, owner, org.id, { email: invitee.email, role: "FINANCE" });

    await revokeInvitation(db, owner, org.id, invitation.id);
    await expect(acceptInvitation(db, invitee, token)).rejects.toMatchObject(invalid);
    expect(await getInvitationForInvitee(db, invitee, token)).toBeNull();
    expect(await roleOf(org.id, invitee.id)).toBeNull();
    await expect(revokeInvitation(db, owner, org.id, invitation.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(resendInvitation(db, owner, org.id, invitation.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await auditActions(invitation.id)).toEqual(["member.invited", "member.invitation_revoked"]);
  });

  it("reenviar troca o token (o anterior deixa de valer) e renova um convite vencido", async () => {
    const { owner, org } = await teamOrg();
    const invitee = await makeUser();
    const { invitation, token: oldToken } = await inviteMember(db, owner, org.id, { email: invitee.email, role: "EVENT_MANAGER" });
    await db.organizationInvitation.update({ where: { id: invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await listPendingInvitations(db, owner, org.id))[0]).toMatchObject({ id: invitation.id, expired: true });

    const { token: newToken, invitation: renewed } = await resendInvitation(db, owner, org.id, invitation.id);
    expect(newToken).not.toBe(oldToken);
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await expect(acceptInvitation(db, invitee, oldToken)).rejects.toMatchObject(invalid);
    expect(await getInvitationForInvitee(db, invitee, newToken)).toMatchObject({ emailMatches: true, organizationName: org.name, role: "EVENT_MANAGER" });
    await acceptInvitation(db, invitee, newToken);
    expect(await roleOf(org.id, invitee.id)).toBe("EVENT_MANAGER");
    expect(await listPendingInvitations(db, owner, org.id)).toEqual([]);
    expect(await auditActions(invitation.id)).toEqual(["member.invited", "member.invitation_resent", "member.joined"]);
  });

  it("o convidado recusa; só a conta do e-mail convidado pode recusar", async () => {
    const { owner, org } = await teamOrg();
    const invitee = await makeUser();
    const stranger = await makeUser();
    const { invitation, token } = await inviteMember(db, owner, org.id, { email: invitee.email, role: "CHECKIN_STAFF" });

    await expect(declineInvitation(db, stranger, token)).rejects.toMatchObject(forbidden);
    expect(await getInvitationForInvitee(db, stranger, token)).toEqual({ emailMatches: false });
    await declineInvitation(db, invitee, token);
    await expect(acceptInvitation(db, invitee, token)).rejects.toMatchObject(invalid);
    await expect(declineInvitation(db, invitee, token)).rejects.toMatchObject(invalid);
    expect(await listPendingInvitations(db, owner, org.id)).toEqual([]);
    const declined = await db.auditLog.findFirstOrThrow({ where: { entityId: invitation.id, action: "member.invitation_declined" } });
    expect(declined.actorUserId).toBe(invitee.id);
  });

  it("lista de pendentes traz evento e quem convidou, sem aceitos/revogados", async () => {
    const { owner, org } = await teamOrg();
    const event = await makeEvent(org);
    const a = await inviteMember(db, owner, org.id, { email: "a@test.local", role: "CHECKIN_STAFF", eventId: event.id });
    const b = await inviteMember(db, owner, org.id, { email: "b@test.local", role: "FINANCE" });
    await revokeInvitation(db, owner, org.id, b.invitation.id);
    const list = await listPendingInvitations(db, owner, org.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: a.invitation.id, email: "a@test.local", eventTitle: event.title, invitedByName: owner.name, expired: false });
  });

  it("autorização negada: outra organização, papéis sem members:manage e papel acima do próprio", async () => {
    const { owner, org, others } = await teamOrg([{ role: "ADMIN" }, { role: "EVENT_MANAGER" }, { role: "FINANCE" }]);
    const [admin, manager, finance] = others;
    const { owner: ownerB, org: orgB } = await teamOrg();
    const { invitation, token } = await inviteMember(db, owner, org.id, { email: "x@test.local", role: "ADMIN" });

    for (const actor of [manager, finance, ownerB]) {
      await expect(listPendingInvitations(db, actor, org.id)).rejects.toMatchObject(forbidden);
      await expect(revokeInvitation(db, actor, org.id, invitation.id)).rejects.toMatchObject(forbidden);
      await expect(resendInvitation(db, actor, org.id, invitation.id)).rejects.toMatchObject(forbidden);
      await expect(inviteMember(db, actor, org.id, { email: "y@test.local", role: "CHECKIN_STAFF" })).rejects.toMatchObject(forbidden);
    }
    // O OWNER de B não alcança um convite de A passando a própria organização.
    await expect(revokeInvitation(db, ownerB, orgB.id, invitation.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(resendInvitation(db, ownerB, orgB.id, invitation.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Conta suspensa não age.
    await expect(revokeInvitation(db, { ...owner, status: "SUSPENDED" }, org.id, invitation.id)).rejects.toMatchObject(forbidden);
    // ADMIN gerencia convites até o próprio nível.
    await resendInvitation(db, admin, org.id, invitation.id);
    await revokeInvitation(db, admin, org.id, invitation.id);
    // Nada aceito com o token original.
    await expect(acceptInvitation(db, await makeUser({ email: "x@test.local" }), token)).rejects.toMatchObject(invalid);
  });

  it("concorrência: aceites simultâneos do mesmo convite criam uma única associação", async () => {
    const { owner, org } = await teamOrg();
    const invitee = await makeUser();
    const { invitation, token } = await inviteMember(db, owner, org.id, { email: invitee.email, role: "FINANCE" });

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => acceptInvitation(db, invitee, token)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject(invalid);
    expect(await db.organizationMember.count({ where: { organizationId: org.id, userId: invitee.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: invitation.id, action: "member.joined" } })).toBe(1);
  });

  it("concorrência: dois convites diferentes para a mesma pessoa aceitos ao mesmo tempo", async () => {
    const { owner, org } = await teamOrg();
    const invitee = await makeUser();
    const a = await inviteMember(db, owner, org.id, { email: invitee.email, role: "FINANCE" });
    const b = await inviteMember(db, owner, org.id, { email: invitee.email, role: "EVENT_MANAGER" });
    const results = await Promise.allSettled([acceptInvitation(db, invitee, a.token), acceptInvitation(db, invitee, b.token)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await db.organizationMember.count({ where: { organizationId: org.id, userId: invitee.id } })).toBe(1);
  });

  it("concorrência: aceite × revogação × reenvio terminam em estado consistente", async () => {
    for (let round = 0; round < 5; round++) {
      const { owner, org } = await teamOrg();
      const invitee = await makeUser();
      const { invitation, token } = await inviteMember(db, owner, org.id, { email: invitee.email, role: "FINANCE" });
      const [accepted] = await Promise.allSettled([
        acceptInvitation(db, invitee, token),
        revokeInvitation(db, owner, org.id, invitation.id),
        resendInvitation(db, owner, org.id, invitation.id),
      ]);
      const inv = await db.organizationInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
      const member = await roleOf(org.id, invitee.id);
      if (accepted.status === "fulfilled") {
        expect(inv.acceptedAt).not.toBeNull();
        expect(inv.revokedAt).toBeNull();
        expect(member).toBe("FINANCE");
      } else {
        expect(inv.acceptedAt).toBeNull();
        expect(member).toBeNull();
      }
    }
  });
});

describe("N — papéis da equipe", () => {
  it("OWNER altera papéis, inclusive cria outro OWNER; tudo auditado com de/para", async () => {
    const { owner, org, others } = await teamOrg([{ role: "ADMIN" }, { role: "CHECKIN_STAFF" }]);
    const [admin, staff] = others;
    const event = await makeEvent(org);
    await db.eventStaffAssignment.create({ data: { eventId: event.id, userId: staff.id, assignedById: owner.id } });

    await changeMemberRole(db, owner, org.id, admin.id, "OWNER");
    expect(await roleOf(org.id, admin.id)).toBe("OWNER");
    await changeMemberRole(db, owner, org.id, staff.id, "EVENT_MANAGER");
    expect(await roleOf(org.id, staff.id)).toBe("EVENT_MANAGER");
    // Atribuições de check-in não sobram para quem deixou de ser CHECKIN_STAFF.
    expect(await db.eventStaffAssignment.count({ where: { userId: staff.id } })).toBe(0);

    const logs = await db.auditLog.findMany({ where: { organizationId: org.id, action: "member.role_changed" }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.metadata)).toEqual([
      { userId: admin.id, from: "ADMIN", to: "OWNER" },
      { userId: staff.id, from: "CHECKIN_STAFF", to: "EVENT_MANAGER" },
    ]);
    expect(logs.every((l) => l.actorUserId === owner.id)).toBe(true);
    // Mesmo papel: nada muda nem é auditado.
    await changeMemberRole(db, owner, org.id, staff.id, "EVENT_MANAGER");
    expect(await db.auditLog.count({ where: { organizationId: org.id, action: "member.role_changed" } })).toBe(2);
  });

  it("escalada de privilégio é bloqueada no servidor", async () => {
    const { owner, org, others } = await teamOrg([{ role: "ADMIN" }, { role: "ADMIN" }, { role: "FINANCE" }, { role: "EVENT_MANAGER" }]);
    const [admin, admin2, finance, manager] = others;

    // ADMIN não cria OWNER (nem a si mesmo) e não mexe em OWNER.
    await expect(changeMemberRole(db, admin, org.id, admin.id, "OWNER")).rejects.toMatchObject(forbidden);
    await expect(changeMemberRole(db, admin, org.id, finance.id, "OWNER")).rejects.toMatchObject(forbidden);
    await expect(changeMemberRole(db, admin, org.id, owner.id, "FINANCE")).rejects.toMatchObject(forbidden);
    await expect(removeMember(db, admin, org.id, owner.id)).rejects.toMatchObject(forbidden);
    // Sem members:manage não altera nada, nem o próprio papel.
    await expect(changeMemberRole(db, manager, org.id, manager.id, "ADMIN")).rejects.toMatchObject(forbidden);
    await expect(changeMemberRole(db, finance, org.id, finance.id, "ADMIN")).rejects.toMatchObject(forbidden);
    // Outra organização.
    const { owner: ownerB } = await teamOrg();
    await expect(changeMemberRole(db, ownerB, org.id, finance.id, "ADMIN")).rejects.toMatchObject(forbidden);
    // Papel inexistente vindo do cliente.
    await expect(changeMemberRole(db, owner, org.id, finance.id, "SUPERUSER" as OrgRole)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await roleOf(org.id, owner.id)).toBe("OWNER");
    expect(await roleOf(org.id, admin.id)).toBe("ADMIN");
    expect(await roleOf(org.id, finance.id)).toBe("FINANCE");
    expect(await db.auditLog.count({ where: { organizationId: org.id, action: "member.role_changed" } })).toBe(0);

    // Até o próprio nível é permitido.
    await changeMemberRole(db, admin, org.id, finance.id, "ADMIN");
    await changeMemberRole(db, admin, org.id, admin2.id, "CHECKIN_STAFF");
    expect(await roleOf(org.id, finance.id)).toBe("ADMIN");
    expect(await roleOf(org.id, admin2.id)).toBe("CHECKIN_STAFF");
  });

  it("um ADMIN rebaixado no meio do caminho perde o poder de alterar papéis", async () => {
    const { owner, org, others } = await teamOrg([{ role: "ADMIN" }, { role: "FINANCE" }]);
    const [admin, finance] = others;
    await changeMemberRole(db, owner, org.id, admin.id, "FINANCE");
    await expect(changeMemberRole(db, admin, org.id, finance.id, "ADMIN")).rejects.toMatchObject(forbidden);
    await expect(inviteMember(db, admin, org.id, { email: "z@test.local", role: "ADMIN" })).rejects.toMatchObject(forbidden);
  });

  it("a organização nunca fica sem OWNER", async () => {
    const { owner, org } = await teamOrg();
    await expect(changeMemberRole(db, owner, org.id, owner.id, "ADMIN")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(removeMember(db, owner, org.id, owner.id)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await roleOf(org.id, owner.id)).toBe("OWNER");
  });

  it("concorrência: dois OWNERs rebaixando um ao outro ao mesmo tempo deixam exatamente um OWNER", async () => {
    for (let round = 0; round < 5; round++) {
      const { owner, org, others } = await teamOrg([{ role: "OWNER" }]);
      const [owner2] = others;
      const results = await Promise.allSettled([
        changeMemberRole(db, owner, org.id, owner2.id, "ADMIN"),
        changeMemberRole(db, owner2, org.id, owner.id, "ADMIN"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await db.organizationMember.count({ where: { organizationId: org.id, role: "OWNER" } })).toBe(1);
    }
  });

  it("concorrência: rebaixar e remover OWNERs ao mesmo tempo mantém um OWNER", async () => {
    for (let round = 0; round < 5; round++) {
      const { owner, org, others } = await teamOrg([{ role: "OWNER" }]);
      const [owner2] = others;
      await Promise.allSettled([removeMember(db, owner, org.id, owner2.id), changeMemberRole(db, owner2, org.id, owner.id, "FINANCE")]);
      expect(await db.organizationMember.count({ where: { organizationId: org.id, role: "OWNER" } })).toBeGreaterThanOrEqual(1);
    }
  });
});
