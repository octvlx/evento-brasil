// Exclusão definitiva de contas de clientes e organizadores pelo superadmin: mesma
// anonimização do titular (L9b), com bloqueios das organizações, confirmação explícita
// (e-mail + motivo + código do autenticador), auditoria e nada de exclusão parcial.
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminRole } from "@/generated/prisma/client";
import { hashPassword } from "@/server/auth/password";
import { createSession, resolveSession } from "@/server/auth/sessions";
import { totpCode, totpStep } from "@/server/auth/totp";
import { REDACTED_NAME, redactedEmail } from "@/server/retention";
import { adminAccountDeletionCheck, adminDeleteAccount, ORPHANED_ORG_REASON } from "@/server/services/account-deletion";
import { confirmTotpEnrollment, startTotpEnrollment } from "@/server/services/two-factor";
import { authenticate } from "@/server/services/users";
import type { Db } from "@/server/db";
import { makeBuyerReady } from "../support/buyer-ready";
import { buy, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

const DAY = 86_400_000;
const PASSWORD = "senha-forte-1";
const REASON = "Pedido do titular pelo SAC";

beforeEach(resetDb);

const T0 = new Date();
let tick = 0;
/** Um instante novo a cada chamada (o código do autenticador vale uma vez por janela de 30 s). */
const next = () => new Date(T0.getTime() + ++tick * 30_000);

/** Admin com o papel pedido e 2FA ativo; `code(when)` gera o código daquele instante. */
async function adminWith(roles: AdminRole[] = ["SUPER_ADMIN"]) {
  const created = await makeUser({ admin: true });
  await db.user.update({ where: { id: created.id }, data: { adminRoles: roles } });
  const { secret } = await startTotpEnrollment(db, created.id, T0);
  await confirmTotpEnrollment(db, created.id, totpCode(secret, totpStep(T0)), null, T0);
  const user = await db.user.findUniqueOrThrow({ where: { id: created.id } });
  return { user, code: (when: Date) => totpCode(secret, totpStep(when)) };
}

async function customer() {
  const user = await makeBuyerReady(await makeUser());
  return db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(PASSWORD), phone: "11912345678" } });
}

/** Leva o evento para o passado (a compra exige vendas abertas). */
async function endEvent(eventId: string, endedAgoMs = DAY) {
  const endsAt = new Date(Date.now() - endedAgoMs);
  const startsAt = new Date(endsAt.getTime() - 4 * 3_600_000);
  await db.event.update({ where: { id: eventId }, data: { salesStartAt: new Date(startsAt.getTime() - 30 * DAY), salesEndAt: startsAt, startsAt, endsAt } });
}

async function del(admin: Awaited<ReturnType<typeof adminWith>>, target: { id: string; email: string }, overrides: Partial<{ confirmEmail: string; reason: string }> = {}, client: Db = db) {
  const when = next();
  return adminDeleteAccount(client, admin.user, target.id, { confirmEmail: target.email, reason: REASON, adminCode: admin.code(when), ...overrides }, when);
}

const unchanged = async (user: { id: string; email: string }) => {
  const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(after.email).toBe(user.email);
  expect(after.anonymizedAt).toBeNull();
};

describe("permissões e confirmação", () => {
  it("só o superadmin exclui; não exclui a própria conta nem a de outro admin", async () => {
    const target = await customer();
    for (const role of ["FINANCE", "SUPPORT", "MODERATION"] as const) {
      const other = await adminWith([role]);
      await expect(del(other, target)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const plain = await makeUser();
    await expect(adminDeleteAccount(db, plain, target.id, { confirmEmail: target.email, reason: REASON, adminCode: "123456" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const superAdmin = await adminWith();
    await expect(del(superAdmin, superAdmin.user)).rejects.toMatchObject({ code: "VALIDATION" });
    const otherSuper = await adminWith();
    await expect(del(superAdmin, otherSuper.user)).rejects.toThrow(/administrador da plataforma/);
    const support = await adminWith(["SUPPORT"]);
    await expect(del(superAdmin, support.user)).rejects.toMatchObject({ code: "INVALID_STATE" });

    await unchanged(target);
    await unchanged(otherSuper.user);
    const blocked = await db.auditLog.findMany({ where: { action: "user.deletion_blocked" }, orderBy: { createdAt: "asc" } });
    expect(blocked.map((l) => [l.actorUserId, l.entityId])).toEqual([
      [superAdmin.user.id, otherSuper.user.id],
      [superAdmin.user.id, support.user.id],
    ]);
    expect(blocked[0].metadata).toMatchObject({ result: "BLOCKED", blockers: ["PLATFORM_ADMIN"] });
  });

  it("exige o e-mail da conta digitado, motivo, 2FA ativo e um código válido; nada muda se faltar algo", async () => {
    const superAdmin = await adminWith();
    const target = await customer();
    await expect(del(superAdmin, target, { confirmEmail: "outra@test.local" })).rejects.toThrow(/e-mail da conta/);
    await expect(del(superAdmin, target, { reason: "  " })).rejects.toMatchObject({ code: "VALIDATION" });
    const when = next();
    await expect(adminDeleteAccount(db, superAdmin.user, target.id, { confirmEmail: target.email, reason: REASON, adminCode: "000000" }, when)).rejects.toMatchObject({ code: "VALIDATION" });

    const no2fa = await makeUser({ admin: true });
    await expect(adminDeleteAccount(db, no2fa, target.id, { confirmEmail: target.email, reason: REASON, adminCode: "123456" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await unchanged(target);
    expect(await db.auditLog.count({ where: { action: "user.deleted_by_admin" } })).toBe(0);
  });
});

describe("cliente", () => {
  it("com histórico financeiro: anonimiza, encerra o acesso, preserva pedido, pagamento e razão, audita sem dado pessoal; repetir não muda nada", async () => {
    const superAdmin = await adminWith();
    const owner = await makeUser();
    const event = await makeEvent(await makeOrg(owner));
    const target = await customer();
    const { order } = await buyAndPay(target, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await endEvent(event.id);
    const session = await createSession(db, target.id, "vitest");

    const result = await del(superAdmin, target);
    expect(result).toMatchObject({ orders: 1, tickets: 1, sessions: 1, suspendedOrganizations: [] });

    const marker = redactedEmail(target.id);
    const after = await db.user.findUniqueOrThrow({ where: { id: target.id }, include: { address: true } });
    expect(after).toMatchObject({ name: REDACTED_NAME, email: marker, phone: null, cpfEncrypted: null, birthDate: null, googleSubject: null, status: "SUSPENDED", address: null });
    expect(after.anonymizedAt).not.toBeNull();
    // Acesso encerrado: a sessão aberta morre e não há login novo, nem com a senha antiga.
    expect(await resolveSession(db, session.token)).toBeNull();
    expect(await authenticate(db, target.email, PASSWORD, { production: false })).toBeNull();
    expect(await authenticate(db, marker, PASSWORD, { production: false })).toBeNull();

    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(paid).toMatchObject({ buyerName: REDACTED_NAME, buyerEmail: marker, status: "PAID", totalCents: order.totalCents });
    expect(paid.payments.map((p) => p.status)).toContain("PAID");
    expect(await db.financialLedgerEntry.count({ where: { orderId: order.id } })).toBeGreaterThan(0);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "user.deleted_by_admin", entityId: target.id } });
    expect(log.actorUserId).toBe(superAdmin.user.id);
    expect(log.metadata).toMatchObject({ result: "ANONYMIZED", reason: REASON, orders: 1, tickets: 1 });
    const text = JSON.stringify(log.metadata);
    expect(text).not.toContain(target.email);
    expect(text).not.toContain(target.name);

    // Repetir (duplo clique, outra aba): erro claro, nenhuma escrita nova.
    await expect(del(superAdmin, { id: target.id, email: marker })).rejects.toThrow(/já foi excluída/);
    expect(await db.auditLog.count({ where: { action: "user.deleted_by_admin" } })).toBe(1);
  });

  it("com ingresso válido para evento futuro ou pedido em aberto: bloqueia, explica, audita e não gasta o código", async () => {
    const superAdmin = await adminWith();
    const event = await makeEvent(await makeOrg(await makeUser()));
    const items = [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }];
    const holder = await customer();
    await buyAndPay(holder, event.id, items);
    const pending = await customer();
    await buy(pending, event.id, items);

    const when = next();
    const code = superAdmin.code(when);
    await expect(adminDeleteAccount(db, superAdmin.user, holder.id, { confirmEmail: holder.email, reason: REASON, adminCode: code }, when)).rejects.toThrow(
      /ingressos válidos para eventos que ainda não terminaram/,
    );
    await expect(del(superAdmin, pending)).rejects.toThrow(/aguardando pagamento/);
    await unchanged(holder);
    await unchanged(pending);
    const logs = await db.auditLog.findMany({ where: { action: "user.deletion_blocked" } });
    expect(logs.map((l) => l.metadata)).toEqual(expect.arrayContaining([expect.objectContaining({ blockers: ["UPCOMING_TICKET"] }), expect.objectContaining({ blockers: ["OPEN_ORDER"] })]));
    // O bloqueio vem antes do código: o mesmo código ainda vale (aqui, numa ação que passa).
    const free = await customer();
    await expect(adminDeleteAccount(db, superAdmin.user, free.id, { confirmEmail: free.email, reason: REASON, adminCode: code }, when)).resolves.toMatchObject({ orders: 0 });
  });
});

describe("organizador", () => {
  it("organização com outro proprietário: só o vínculo sai; a organização, a equipe e as vendas seguem", async () => {
    const superAdmin = await adminWith();
    const target = await customer();
    const coOwner = await makeUser();
    const org = await makeOrg(target, { extraMembers: [{ userId: coOwner.id, role: "OWNER" }] });
    const event = await makeEvent(org);
    await buyAndPay(await customer(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);

    expect((await adminAccountDeletionCheck(db, target.id)).blockers).toEqual([]);
    await del(superAdmin, target);

    const members = await db.organizationMember.findMany({ where: { organizationId: org.id } });
    expect(members.map((m) => [m.userId, m.role])).toEqual([[coOwner.id, "OWNER"]]);
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("APPROVED");
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("PUBLISHED");
    expect(await db.issuedTicket.count({ where: { eventId: event.id, status: "VALID" } })).toBe(1);
  });

  it("única proprietária de organização compartilhada ou com eventos ativos e ingressos vendidos: bloqueia com o motivo de cada organização", async () => {
    const superAdmin = await adminWith();
    const target = await customer();
    const staff = await makeUser();
    const shared = await makeOrg(target, { extraMembers: [{ userId: staff.id, role: "EVENT_MANAGER" }] });
    const solo = await makeOrg(target);
    const event = await makeEvent(solo);
    await buyAndPay(await customer(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);

    const check = await adminAccountDeletionCheck(db, target.id);
    expect(check.blockers.map((b) => [b.code, b.organizationId])).toEqual([
      ["ORG_SHARED_LAST_OWNER", shared.id],
      ["ORG_ACTIVE_EVENTS", solo.id],
      ["ORG_VALID_TICKETS", solo.id],
    ]);
    await expect(del(superAdmin, target)).rejects.toThrow(new RegExp(`única proprietária da organização "${shared.name}"[\\s\\S]*"${solo.name}" tem eventos publicados`));
    await unchanged(target);
    expect(await db.organizationMember.count({ where: { userId: target.id } })).toBe(2);
    expect(await db.organizationMember.count({ where: { userId: staff.id } })).toBe(1);
  });

  it("reembolso pendente e pedido de cancelamento em aberto na organização também bloqueiam", async () => {
    const superAdmin = await adminWith();
    const target = await customer();
    const org = await makeOrg(target);
    const event = await makeEvent(org);
    const { order } = await buyAndPay(await customer(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await endEvent(event.id);
    await db.refund.create({ data: { orderId: order.id, amountCents: 100, status: "FAILED", reason: "ADMIN", idempotencyKey: `t-${order.id}` } });
    await expect(del(superAdmin, target)).rejects.toThrow(/reembolsos pendentes ou com falha/);
    await unchanged(target);
  });

  it("única proprietária e única membro, eventos encerrados e nada pendente: exclui e suspende a organização, preservando eventos, pedidos e ingressos dos compradores", async () => {
    const superAdmin = await adminWith();
    const target = await customer();
    const org = await makeOrg(target);
    const event = await makeEvent(org);
    const buyer = await customer();
    const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await endEvent(event.id);

    const result = await del(superAdmin, target);
    expect(result).toMatchObject({ memberships: 1, suspendedOrganizations: [org.id] });

    expect(await db.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ status: "SUSPENDED", statusReason: ORPHANED_ORG_REASON });
    expect(await db.organizationMember.count({ where: { organizationId: org.id } })).toBe(0);
    // Os direitos do comprador continuam: pedido e ingresso dele, com os dados dele.
    const kept = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(kept).toMatchObject({ status: "PAID", buyerEmail: order.buyerEmail, buyerName: order.buyerName, piiRedactedAt: null });
    expect(kept.buyerName).not.toBe(REDACTED_NAME);
    expect(await db.issuedTicket.count({ where: { orderId: order.id, holderUserId: buyer.id } })).toBe(1);
    expect(await db.event.count({ where: { id: event.id } })).toBe(1);
    const suspended = await db.auditLog.findFirstOrThrow({ where: { action: "organization.suspended", organizationId: org.id } });
    expect(suspended.actorUserId).toBe(superAdmin.user.id);
  });
});

describe("falhas e concorrência", () => {
  it("falha no meio da transação desfaz tudo e registra a tentativa", async () => {
    const superAdmin = await adminWith();
    const target = await customer();
    const org = await makeOrg(target);
    await createSession(db, target.id, "vitest");
    // A gravação final da auditoria falha depois de anonimizar e suspender: tudo volta.
    const failing = new Proxy(db, {
      get(real, prop) {
        if (prop !== "$transaction") return Reflect.get(real, prop);
        return (fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
          real.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p) {
                    if (p === "auditLog")
                      return {
                        create: async (args: Parameters<typeof t.auditLog.create>[0]) =>
                          args.data.action === "user.deleted_by_admin" ? Promise.reject(new Error("falha simulada")) : t.auditLog.create(args),
                      };
                    return Reflect.get(t, p);
                  },
                }),
              ),
            opts as never,
          );
      },
    }) as Db;

    await expect(del(superAdmin, target, {}, failing)).rejects.toThrow("falha simulada");
    await unchanged(target);
    expect(await db.session.count({ where: { userId: target.id } })).toBe(1);
    expect(await db.organizationMember.count({ where: { userId: target.id } })).toBe(1);
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).status).toBe("APPROVED");
    expect(await db.auditLog.count({ where: { action: { in: ["user.deleted_by_admin", "organization.suspended"] } } })).toBe(0);
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "user.deletion_failed", entityId: target.id } })).metadata).toMatchObject({ result: "FAILED" });

    // Depois da falha, a nova tentativa conclui normalmente.
    await expect(del(superAdmin, target)).resolves.toMatchObject({ suspendedOrganizations: [org.id] });
  });

  it("dois superadmins ao mesmo tempo: uma exclusão vale, a outra recebe 'já foi excluída'", async () => {
    const a = await adminWith();
    const b = await adminWith();
    const target = await customer();
    const results = await Promise.allSettled([del(a, target), del(b, target)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason.message)).toMatch(/já foi excluída/);
    expect(await db.auditLog.count({ where: { action: "user.deleted_by_admin", entityId: target.id } })).toBe(1);
  });
});
