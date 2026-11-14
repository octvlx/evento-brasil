// Integridade: permissão do check-in conferida na mesma transação da entrada (sob a
// trava da organização) e escritas do admin com trava, transação e valor anterior.
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth/sessions";
import { checkInTicket } from "@/server/services/checkin";
import { setEventFeatured } from "@/server/services/events";
import { assignStaffToEvent, changeMemberRole, setAutoPublish } from "@/server/services/organizers";
import { qrPayload } from "@/server/services/tickets";
import { setUserSuspended } from "@/server/services/users";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup() {
  const owner = await makeUser();
  const staff = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: staff.id, role: "CHECKIN_STAFF" }] });
  const event = await makeEvent(org);
  await assignStaffToEvent(db, owner, event.id, staff.id, true);
  const { order } = await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
  const tickets = await db.issuedTicket.findMany({ where: { orderId: order.id } });
  return { owner, staff, org, event, tickets };
}

/** Segura a trava da equipe (como `lockOrganizationTeam`) e roda `change` até `release`. */
function holdTeamLock(organizationId: string, change: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>) {
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const acquired = new Promise<void>((r) => (locked = r));
  const done = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`;
      await change(tx);
      locked();
      await gate;
    },
    { timeout: 20_000 },
  );
  return { acquired, release, done };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("check-in: permissão na transação da entrada", () => {
  it("leitura que começa durante a retirada da portaria espera e é recusada", async () => {
    const { staff, org, event, tickets } = await setup();
    expect((await checkInTicket(db, staff, event.id, qrPayload(tickets[0]))).result).toBe("ADMITTED");

    const hold = holdTeamLock(org.id, (tx) => tx.eventStaffAssignment.deleteMany({ where: { eventId: event.id, userId: staff.id } }));
    await hold.acquired;
    const scan = checkInTicket(db, staff, event.id, qrPayload(tickets[1]));
    const settled = scan.then(() => "done", () => "done");
    await pause(300);
    // Ainda esperando a trava: a retirada não terminou.
    expect(await Promise.race([settled, pause(10).then(() => "waiting")])).toBe("waiting");
    hold.release();
    await hold.done;
    await expect(scan).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: tickets[1].id } })).status).toBe("VALID");
    expect(await db.ticketCheckin.count({ where: { ticketId: tickets[1].id } })).toBe(0);
  });

  it("troca de papel também corta a portaria; atribuir de novo devolve o acesso", async () => {
    const { owner, staff, org, event, tickets } = await setup();
    await changeMemberRole(db, owner, org.id, staff.id, "FINANCE");
    await expect(checkInTicket(db, staff, event.id, qrPayload(tickets[0]))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await changeMemberRole(db, owner, org.id, staff.id, "CHECKIN_STAFF");
    await assignStaffToEvent(db, owner, event.id, staff.id, true);
    expect((await checkInTicket(db, staff, event.id, qrPayload(tickets[0]))).result).toBe("ADMITTED");
    expect(await db.auditLog.count({ where: { entityId: event.id, action: "staff.assigned" } })).toBe(2);
  });

  it("leituras simultâneas do mesmo ingresso continuam admitindo uma vez só", async () => {
    const { owner, staff, event, tickets } = await setup();
    const results = await Promise.all([checkInTicket(db, staff, event.id, qrPayload(tickets[0])), checkInTicket(db, owner, event.id, qrPayload(tickets[0]))]);
    expect(results.map((r) => r.result).sort()).toEqual(["ADMITTED", "DUPLICATE"]);
  });
});

describe("escritas do admin", () => {
  it("suspender e reativar ao mesmo tempo: status, sessões e auditoria concordam", async () => {
    const admin = await makeUser({ admin: true });
    for (let round = 0; round < 3; round++) {
      const user = await makeUser();
      await createSession(db, user.id);
      await Promise.all([setUserSuspended(db, admin, user.id, true, "Fraude"), setUserSuspended(db, admin, user.id, false)]);
      const final = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      const logs = await db.auditLog.findMany({ where: { entityId: user.id }, orderBy: { createdAt: "asc" } });
      const meta = logs.map((l) => l.metadata as { previousStatus: string; newStatus: string });
      expect(meta).toHaveLength(2);
      // Em ordem: cada mudança parte do status deixado pela anterior.
      expect(meta[0].previousStatus).toBe("ACTIVE");
      expect(meta[1].previousStatus).toBe(meta[0].newStatus);
      expect(final.status).toBe(meta[1].newStatus);
      if (final.status === "SUSPENDED") expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    }
  });

  it("auto-publicação e destaque registram o valor anterior e não auditam quando nada muda", async () => {
    const admin = await makeUser({ admin: true });
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const event = await makeEvent(org);

    await setAutoPublish(db, admin, org.id, true);
    await setAutoPublish(db, admin, org.id, true);
    const pub = await db.auditLog.findMany({ where: { entityId: org.id, action: "organization.auto_publish" } });
    expect(pub.map((l) => l.metadata)).toEqual([{ value: true, previous: false }]);

    await Promise.all([setEventFeatured(db, admin, event.id, true), setEventFeatured(db, admin, event.id, true)]);
    const feat = await db.auditLog.findMany({ where: { entityId: event.id, action: "event.featured" } });
    expect(feat).toHaveLength(1);
    expect(feat[0]).toMatchObject({ organizationId: org.id, metadata: { featured: true, previous: false } });
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).isFeatured).toBe(true);
  });
});
