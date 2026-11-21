// Denúncias de eventos: registro pelo público e decisão da moderação (por evento).
import { beforeEach, describe, expect, it } from "vitest";
import { decideEventReports, listOpenEventReports, reportEvent } from "@/server/services/event-reports";
import { operationalHealth } from "@/server/services/ops-health";
import { db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  return { owner, org, event };
}

describe("reportEvent", () => {
  it("registra, recusa a repetida enquanto aberta e audita", async () => {
    const { event } = await setup();
    const user = await makeUser();
    const report = await reportEvent(db, user, event.id, { reason: "FRAUD", details: "  Pediram PIX por fora  " });
    expect(report).toMatchObject({ status: "OPEN", reason: "FRAUD", details: "Pediram PIX por fora", reporterId: user.id });
    await expect(reportEvent(db, user, event.id, { reason: "MISLEADING" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.auditLog.count({ where: { action: "event.reported", entityId: event.id } })).toBe(1);
  });

  it("recusa: 'outro motivo' sem detalhes, membro da organização, evento em rascunho ou suspenso, conta suspensa", async () => {
    const { owner, org, event } = await setup();
    const user = await makeUser();
    await expect(reportEvent(db, user, event.id, { reason: "OTHER" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(reportEvent(db, owner, event.id, { reason: "FRAUD" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const draft = await makeEvent(org, { status: "DRAFT" });
    await expect(reportEvent(db, user, draft.id, { reason: "FRAUD" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.event.update({ where: { id: event.id }, data: { suspendedAt: new Date(), suspensionReason: "teste", suspendedById: owner.id } });
    await expect(reportEvent(db, user, event.id, { reason: "FRAUD" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const other = (await setup()).event;
    const suspended = await db.user.update({ where: { id: (await makeUser()).id }, data: { status: "SUSPENDED" } });
    await expect(reportEvent(db, suspended, other.id, { reason: "FRAUD" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("moderação", () => {
  it("fila por evento (mais denunciado primeiro); decisão fecha todas as abertas e permite nova denúncia depois", async () => {
    const admin = await makeUser({ admin: true });
    const { event: a } = await setup();
    const { event: b } = await setup();
    const [u1, u2] = [await makeUser(), await makeUser()];
    await reportEvent(db, u1, a.id, { reason: "FRAUD" });
    await reportEvent(db, u1, b.id, { reason: "INAPPROPRIATE" });
    await reportEvent(db, u2, b.id, { reason: "OTHER", details: "Imagem ofensiva na capa" });

    const queue = await listOpenEventReports(db, admin);
    expect(queue.items.map((i) => [i.event.id, i.count])).toEqual([
      [b.id, 2],
      [a.id, 1],
    ]);
    expect(queue.items[0].reports.map((r) => r.reporter.name)).toEqual([u1.name, u2.name]);

    // Procedente exige nota.
    await expect(decideEventReports(db, admin, b.id, { decision: "RESOLVED" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await decideEventReports(db, admin, b.id, { decision: "RESOLVED", note: "Capa trocada pelo organizador" })).toEqual({ count: 2 });
    const decided = await db.eventReport.findMany({ where: { eventId: b.id } });
    expect(decided.every((r) => r.status === "RESOLVED" && r.decidedById === admin.id && r.decisionNote === "Capa trocada pelo organizador")).toBe(true);
    // Nada mais aberto: segunda decisão (outra aba) é CONFLICT.
    await expect(decideEventReports(db, admin, b.id, { decision: "DISMISSED" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Depois da decisão, a mesma pessoa pode denunciar de novo (índice parcial só nas abertas).
    await reportEvent(db, u1, b.id, { reason: "MISLEADING" });

    await decideEventReports(db, admin, a.id, { decision: "DISMISSED" });
    expect((await db.eventReport.findFirstOrThrow({ where: { eventId: a.id } })).status).toBe("DISMISSED");
    expect(await db.auditLog.count({ where: { action: { in: ["event.reports_resolved", "event.reports_dismissed"] } } })).toBe(2);
  });

  it("só quem tem events:moderate vê a fila e decide", async () => {
    const { event } = await setup();
    await reportEvent(db, await makeUser(), event.id, { reason: "FRAUD" });
    const support = await db.user.update({ where: { id: (await makeUser({ admin: true })).id }, data: { adminRoles: ["SUPPORT"] } });
    await expect(listOpenEventReports(db, support)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideEventReports(db, support, event.id, { decision: "DISMISSED" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const moderator = await db.user.update({ where: { id: (await makeUser({ admin: true })).id }, data: { adminRoles: ["MODERATION"] } });
    expect((await listOpenEventReports(db, moderator)).total).toBe(1);
  });

  it("alerta na saúde da operação quando há denúncia aberta há mais de 24 h", async () => {
    const { event } = await setup();
    const report = await reportEvent(db, await makeUser(), event.id, { reason: "FRAUD" });
    expect((await operationalHealth(db)).find((c) => c.code === "EVENT_REPORTS_PENDING")).toBeUndefined();
    await db.eventReport.update({ where: { id: report.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect((await operationalHealth(db)).find((c) => c.code === "EVENT_REPORTS_PENDING")).toMatchObject({ count: 1, href: "/admin/denuncias" });
  });

  it("o banco garante decisão completa e uma aberta por pessoa", async () => {
    const { event } = await setup();
    const user = await makeUser();
    const report = await reportEvent(db, user, event.id, { reason: "FRAUD" });
    await expect(db.eventReport.update({ where: { id: report.id }, data: { status: "DISMISSED" } })).rejects.toThrow();
    await expect(db.eventReport.create({ data: { eventId: event.id, reporterId: user.id, reason: "FRAUD" } })).rejects.toThrow();
  });
});
