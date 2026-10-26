// Fluxo M: decisões do admin (aprovar/rejeitar organização, suspender, moderar
// evento) são transições atômicas — duas decisões simultâneas sobre a mesma
// linha nunca têm sucesso ambas a partir do mesmo estado.
//
// Para tornar a corrida determinística, uma terceira conexão segura a linha com
// FOR UPDATE; as chamadas concorrentes começam, esperamos até que todas estejam
// bloqueadas no banco (pg_locks) e só então liberamos a linha.
import { beforeEach, describe, expect, it } from "vitest";
import { moderateEvent } from "@/server/services/events";
import { reviewOrganization, setOrganizationSuspended } from "@/server/services/organizers";
import { db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function waitForBlockedLocks(n: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [{ count }] = await db.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted`;
    if (count >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`esperava ${n} transações bloqueadas`);
}

/** Dispara `calls` ao mesmo tempo com a linha travada e só libera quando todas esperam por ela. */
async function raceOnLockedRow<T>(table: "Organization" | "Event", id: string, calls: (() => Promise<T>)[]) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let markLocked!: () => void;
  const locked = new Promise<void>((r) => (markLocked = r));
  const holder = db.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
      markLocked();
      await released;
    },
    { timeout: 30_000 },
  );
  await locked;
  const results = Promise.allSettled(calls.map((call) => call()));
  await waitForBlockedLocks(calls.length);
  release();
  await holder;
  return results;
}

function fulfilled<T>(results: PromiseSettledResult<T>[]) {
  return results.filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled");
}

function rejected<T>(results: PromiseSettledResult<T>[]) {
  return results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
}

async function orgAudit(organizationId: string) {
  return db.auditLog.findMany({ where: { entityType: "Organization", entityId: organizationId }, orderBy: { createdAt: "asc" } });
}

describe("P — aprovações do admin sob concorrência", () => {
  it("dois admins decidindo a mesma organização pendente: só um vence", async () => {
    const [adminA, adminB] = await Promise.all([makeUser({ admin: true }), makeUser({ admin: true })]);
    const owner = await makeUser();
    const org = await makeOrg(owner, { status: "PENDING_REVIEW" });
    await db.organizerVerification.create({
      data: {
        organizationId: org.id,
        legalType: "COMPANY",
        legalName: "Org LTDA",
        documentType: "CNPJ",
        documentEncrypted: "x",
        documentLast4: "0181",
        submittedById: owner.id,
      },
    });

    const results = await raceOnLockedRow("Organization", org.id, [
      () => reviewOrganization(db, adminA, org.id, "APPROVE"),
      () => reviewOrganization(db, adminB, org.id, "REJECT", "Documento ilegível"),
    ]);

    expect(fulfilled(results)).toHaveLength(1);
    expect(rejected(results)).toHaveLength(1);
    expect(rejected(results)[0].reason).toMatchObject({ code: "INVALID_STATE" });
    const winner = fulfilled(results)[0].value;
    const final = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(final.status).toBe(winner.status);
    const verification = await db.organizerVerification.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(verification.status).toBe(winner.status);

    const logs = await orgAudit(org.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toMatchObject({ previousStatus: "PENDING_REVIEW", newStatus: winner.status });
  });

  it("aprovação duplicada (duplo clique) grava uma única decisão", async () => {
    const admin = await makeUser({ admin: true });
    const org = await makeOrg(await makeUser(), { status: "PENDING_REVIEW" });

    const results = await raceOnLockedRow("Organization", org.id, [
      () => reviewOrganization(db, admin, org.id, "APPROVE"),
      () => reviewOrganization(db, admin, org.id, "APPROVE"),
    ]);

    expect(fulfilled(results)).toHaveLength(1);
    expect(rejected(results)[0].reason).toMatchObject({ code: "INVALID_STATE" });
    expect(await orgAudit(org.id)).toHaveLength(1);
  });

  it("aprovação repetida depois da decisão é recusada sem nova auditoria", async () => {
    const admin = await makeUser({ admin: true });
    const org = await makeOrg(await makeUser(), { status: "PENDING_REVIEW" });
    await reviewOrganization(db, admin, org.id, "APPROVE");
    await expect(reviewOrganization(db, admin, org.id, "APPROVE")).rejects.toMatchObject({ code: "INVALID_STATE", message: "A organização não está em análise." });
    await expect(reviewOrganization(db, admin, org.id, "REJECT", "Mudei de ideia")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("APPROVED");
    const logs = await orgAudit(org.id);
    expect(logs.map((l) => l.action)).toEqual(["organization.approved"]);
  });

  it("aprovar × suspender ao mesmo tempo: a suspensão nunca é sobrescrita", async () => {
    // Várias rodadas: a ordem em que as duas transações acordam varia.
    for (let round = 0; round < 4; round++) {
      const [adminA, adminB] = await Promise.all([makeUser({ admin: true }), makeUser({ admin: true })]);
      const org = await makeOrg(await makeUser(), { status: "PENDING_REVIEW" });

      const results = await raceOnLockedRow("Organization", org.id, [
        () => reviewOrganization(db, adminA, org.id, "APPROVE"),
        () => setOrganizationSuspended(db, adminB, org.id, true, "Denúncia de fraude"),
      ]);

      const final = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
      expect(final.status).toBe("SUSPENDED");
      // A trilha de auditoria encadeia: cada decisão parte do estado deixado pela anterior.
      const logs = await orgAudit(org.id);
      expect(logs).toHaveLength(fulfilled(results).length);
      let status = "PENDING_REVIEW";
      for (const log of logs) {
        expect(log.metadata).toMatchObject({ previousStatus: status });
        status = (log.metadata as { newStatus: string }).newStatus;
      }
      expect(status).toBe("SUSPENDED");
      for (const r of rejected(results)) expect(r.reason).toMatchObject({ code: "INVALID_STATE" });
    }
  });

  it("suspender × reativar ao mesmo tempo deixa estado e auditoria consistentes", async () => {
    const [adminA, adminB] = await Promise.all([makeUser({ admin: true }), makeUser({ admin: true })]);
    const org = await makeOrg(await makeUser(), { status: "APPROVED" });
    await setOrganizationSuspended(db, adminA, org.id, true, "Investigação");

    const results = await raceOnLockedRow("Organization", org.id, [
      () => setOrganizationSuspended(db, adminA, org.id, false),
      () => setOrganizationSuspended(db, adminB, org.id, false),
    ]);

    expect(fulfilled(results)).toHaveLength(2); // reativar já reativada é idempotente
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("APPROVED");
    const logs = await orgAudit(org.id);
    expect(logs.map((l) => l.action)).toEqual(["organization.suspended", "organization.reinstated"]);
    expect(logs[0].metadata).toMatchObject({ previousStatus: "APPROVED", newStatus: "SUSPENDED", reason: "Investigação" });
    expect(logs[1].metadata).toMatchObject({ previousStatus: "SUSPENDED", newStatus: "APPROVED" });
  });

  it("dois moderadores no mesmo evento pendente: só um vence", async () => {
    const [adminA, adminB] = await Promise.all([makeUser({ admin: true }), makeUser({ admin: true })]);
    const org = await makeOrg(await makeUser());
    const event = await makeEvent(org, { status: "DRAFT" });
    await db.event.update({ where: { id: event.id }, data: { status: "PENDING_REVIEW" } });

    const results = await raceOnLockedRow("Event", event.id, [
      () => moderateEvent(db, adminA, event.id, "APPROVE"),
      () => moderateEvent(db, adminB, event.id, "REJECT", "Ajuste a descrição"),
    ]);

    expect(fulfilled(results)).toHaveLength(1);
    expect(rejected(results)[0].reason).toMatchObject({ code: "INVALID_STATE", message: "O evento não está aguardando moderação." });
    const winner = fulfilled(results)[0].value;
    const final = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(final.status).toBe(winner.status);
    expect(final.moderationNote).toBe(winner.status === "DRAFT" ? "Ajuste a descrição" : null);
    expect(final.publishedAt === null).toBe(winner.status === "DRAFT");

    const logs = await db.auditLog.findMany({ where: { entityType: "Event", entityId: event.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toMatchObject({ previousStatus: "PENDING_REVIEW", newStatus: winner.status });
  });
});
