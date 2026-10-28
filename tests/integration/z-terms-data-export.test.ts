// Fase 3 (Decreto 13.108/2026): aceite de termos versionados (R10, L10a) e
// exportação dos dados do titular (R9, L9b). As Server Actions e a rota de
// exportação rodam de verdade; só o pedido HTTP (cookies, cabeçalhos, sessão) é simulado.
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TermsKind } from "@/generated/prisma/client";
import { registerUser } from "@/server/services/users";
import { currentTermsVersions, pendingTermsKinds, recordAcceptance } from "@/server/services/terms";
import { db, buyAndPay, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

let currentUser: Awaited<ReturnType<typeof makeUser>> | null = null;
let ipCounter = 0;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {} }),
  // IP distinto por chamada: o limite por IP das ações não interfere entre testes.
  headers: async () => new Headers({ "x-forwarded-for": `203.0.113.${++ipCounter % 250}`, "user-agent": "vitest-agent" }),
}));
vi.mock("next/cache", () => ({ refresh: () => {} }));
vi.mock("@/server/auth/current", () => ({
  ACTIVE_ORG_COOKIE: "eb_org",
  getCurrentUser: async () => currentUser,
  requireUser: async () => currentUser,
  requireAdmin: async () => currentUser,
  getActiveMembership: async () => ({ active: null, memberships: [] }),
}));

const { createOrderAction, startPaymentAction } = await import("@/features/orders/actions");
const { createOrganizationAction } = await import("@/features/organizer/actions");
const { GET: exportData } = await import("@/app/api/minha-conta/dados/route");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function publish(kind: TermsKind, version: string, publishedAt = new Date(Date.now() - 1000)) {
  return db.termsVersion.create({ data: { kind, version, textHash: sha256(`${kind}:${version}`), documentPath: kind === "PRIVACY" ? "/privacidade" : "/termos", publishedAt } });
}

async function publishV1() {
  return Promise.all([publish("BUYER", "v1"), publish("PRIVACY", "v1"), publish("ORGANIZER", "v1")]);
}

async function shop() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets: [{ name: "Inteira", priceCents: 10000, quantityTotal: 50 }, { name: "Grátis", priceCents: 0, quantityTotal: 50 }] });
  return { owner, org, event, paid: event.ticketTypes[0], free: event.ticketTypes[1] };
}

const signup = (email: string) =>
  registerUser(db, { name: "Comprador", email, password: "senha-forte-1", acceptTerms: true, acceptPrivacy: true }, { ip: "198.51.100.9", userAgent: "vitest-agent" });

beforeEach(async () => {
  await resetDb();
  currentUser = null;
});

describe("aceite de termos versionados (R10)", () => {
  it("cadastro exige os dois aceites e grava SIGNUP das versões vigentes, com IP e agente", async () => {
    await publishV1();
    await expect(registerUser(db, { name: "Sem aceite", email: "a@test.local", password: "senha-forte-1", acceptTerms: true } as never)).rejects.toThrow();
    expect(await db.user.count({ where: { email: "a@test.local" } })).toBe(0);

    const user = await signup("b@test.local");
    const rows = await db.termsAcceptance.findMany({ where: { userId: user.id }, include: { termsVersion: true } });
    expect(rows.map((r) => r.termsVersion.kind).sort()).toEqual(["BUYER", "PRIVACY"]);
    expect(rows.every((r) => r.context === "SIGNUP" && r.ip === "198.51.100.9" && r.userAgent === "vitest-agent" && !r.orderId)).toBe(true);
    expect(await pendingTermsKinds(db, user.id)).toEqual([]);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "user.registered", entityId: user.id } });
    expect(log.metadata).toMatchObject({ termsAccepted: expect.arrayContaining(["BUYER:v1", "PRIVACY:v1"]) });
  });

  it("vigente = maior publishedAt já publicado; versão futura ainda não vale", async () => {
    await publish("BUYER", "v1", new Date(Date.now() - 86_400_000));
    await publish("BUYER", "v2", new Date(Date.now() - 1000));
    await publish("BUYER", "v3", new Date(Date.now() + 86_400_000));
    const [v] = await currentTermsVersions(db, ["BUYER"]);
    expect(v.version).toBe("v2");
  });

  it("sem TermsVersion no banco: nada a aceitar, cadastro e compra seguem e nada é gravado", async () => {
    const { event, paid } = await shop();
    currentUser = await signup("semtermos@test.local");
    const res = await createOrderAction(orderInput(event.id, [{ ticketTypeId: paid.id, quantity: 1 }]));
    expect(res.ok).toBe(true);
    expect(await db.termsAcceptance.count()).toBe(0);
  });

  it("compra sem aceite da versão vigente é recusada no servidor; com aceite, grava CHECKOUT ligado ao pedido", async () => {
    await publishV1();
    const { event, paid } = await shop();
    // Conta antiga (antes dos termos): nunca aceitou nada.
    currentUser = await makeUser();
    const input = () => orderInput(event.id, [{ ticketTypeId: paid.id, quantity: 1 }]);

    const refused = await createOrderAction(input());
    expect(refused).toMatchObject({ ok: false, code: "TERMS_REQUIRED" });
    // A UI não decide: acceptTerms false também é recusado, e nenhum pedido nasce.
    expect(await createOrderAction(input(), { acceptTerms: false })).toMatchObject({ ok: false, code: "TERMS_REQUIRED" });
    expect(await db.order.count({ where: { userId: currentUser.id } })).toBe(0);

    const ok = await createOrderAction(input(), { acceptTerms: true });
    if (!ok.ok) throw new Error(ok.error);
    const rows = await db.termsAcceptance.findMany({ where: { userId: currentUser.id }, include: { termsVersion: true } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.context === "CHECKOUT" && r.orderId === ok.data.orderId && r.userAgent === "vitest-agent")).toBe(true);

    // Já aceito: a próxima compra não pede nem grava de novo.
    const again = await createOrderAction(input());
    expect(again.ok).toBe(true);
    expect(await db.termsAcceptance.count({ where: { userId: currentUser.id } })).toBe(2);
  });

  it("pedido gratuito (emitido na hora) também passa pelo portão", async () => {
    await publishV1();
    const { event, free } = await shop();
    currentUser = await makeUser();
    expect(await createOrderAction(orderInput(event.id, [{ ticketTypeId: free.id, quantity: 1 }]))).toMatchObject({ ok: false, code: "TERMS_REQUIRED" });
    expect(await db.issuedTicket.count({ where: { userId: currentUser.id } })).toBe(0);
  });

  it("versão nova exige reaceite: no pedido novo e no pagamento de pedido reservado antes", async () => {
    await publishV1();
    const { event, paid } = await shop();
    const user = await signup("reaceite@test.local");
    currentUser = user;
    const reserved = await createOrderAction(orderInput(event.id, [{ ticketTypeId: paid.id, quantity: 1 }]));
    if (!reserved.ok) throw new Error(reserved.error);

    const v2 = await publish("BUYER", "v2");
    expect(await pendingTermsKinds(db, user.id)).toEqual(["BUYER"]);
    expect(await createOrderAction(orderInput(event.id, [{ ticketTypeId: paid.id, quantity: 1 }]))).toMatchObject({ ok: false, code: "TERMS_REQUIRED" });

    // Pagamento do pedido reservado antes da v2: recusado sem aceite, nenhum pagamento iniciado.
    expect(await startPaymentAction(reserved.data.orderId, "PIX")).toMatchObject({ ok: false, code: "TERMS_REQUIRED" });
    expect(await db.payment.count({ where: { orderId: reserved.data.orderId } })).toBe(0);

    // Aceite no pedido de outra pessoa: recusado e nada gravado.
    currentUser = await makeUser();
    await recordAcceptance(db, currentUser.id, ["BUYER", "PRIVACY"], { context: "SIGNUP" });
    await publish("PRIVACY", "v2");
    expect(await startPaymentAction(reserved.data.orderId, "PIX", undefined, true)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await db.termsAcceptance.count({ where: { orderId: reserved.data.orderId } })).toBe(0);

    currentUser = user;
    const paidRes = await startPaymentAction(reserved.data.orderId, "PIX", undefined, true);
    expect(paidRes.ok).toBe(true);
    const checkout = await db.termsAcceptance.findMany({ where: { userId: user.id, context: "CHECKOUT" }, include: { termsVersion: true } });
    // Pendentes no momento: BUYER v2 e PRIVACY v2 (publicada depois).
    expect(checkout.map((r) => `${r.termsVersion.kind}:${r.termsVersion.version}`).sort()).toEqual(["BUYER:v2", "PRIVACY:v2"]);
    expect(checkout.find((r) => r.termsVersionId === v2.id)?.orderId).toBe(reserved.data.orderId);
    expect(await pendingTermsKinds(db, user.id)).toEqual([]);
  });

  it("recordAcceptance é idempotente por usuário + versão, mesmo em chamadas concorrentes", async () => {
    await publishV1();
    const user = await makeUser();
    const results = await Promise.all(Array.from({ length: 4 }, () => recordAcceptance(db, user.id, ["BUYER", "PRIVACY"], { context: "REACCEPT" })));
    expect(results.flat()).toHaveLength(2);
    expect(await db.termsAcceptance.count({ where: { userId: user.id } })).toBe(2);
  });

  it("cadastro de organização grava ORGANIZER_SIGNUP por organização", async () => {
    await publishV1();
    currentUser = await signup("org@test.local");
    const input = (name: string) => ({ name, legalType: "INDIVIDUAL" as const, legalName: "Fulana de Tal", document: "529.982.247-25", contactEmail: "org@test.local" });
    const a = await createOrganizationAction(input("Org Um"));
    const b = await createOrganizationAction(input("Org Dois"));
    if (!a.ok || !b.ok) throw new Error("cadastro de organização falhou");
    const rows = await db.termsAcceptance.findMany({ where: { userId: currentUser.id, context: "ORGANIZER_SIGNUP" }, include: { termsVersion: true } });
    expect(rows.map((r) => r.organizationId).sort()).toEqual([a.data.id, b.data.id].sort());
    expect(rows.every((r) => r.termsVersion.kind === "ORGANIZER")).toBe(true);
    // Repetir para a mesma organização não duplica.
    await recordAcceptance(db, currentUser.id, ["ORGANIZER"], { context: "ORGANIZER_SIGNUP", organizationId: a.data.id });
    expect(await db.termsAcceptance.count({ where: { organizationId: a.data.id } })).toBe(1);
  });
});

describe("baixar meus dados (R9)", () => {
  it("exige sessão", async () => {
    expect((await exportData()).status).toBe(401);
  });

  it("exporta só os dados da própria conta, sem segredos, e registra a exportação", async () => {
    await publishV1();
    const { event, paid } = await shop();
    const me = await signup("eu@test.local");
    const other = await signup("outra@test.local");
    const { order: mine } = await buyAndPay(me, event.id, [{ ticketTypeId: paid.id, quantity: 2 }]);
    const { order: theirs } = await buyAndPay(other, event.id, [{ ticketTypeId: paid.id, quantity: 1 }]);
    const [myTicket] = await db.issuedTicket.findMany({ where: { orderId: mine.id }, orderBy: { sequence: "asc" } });
    const theirTicket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: theirs.id } });
    // Transferência enviada por mim e uma recebida da outra conta.
    const transfer = (from: { id: string }, to: { id: string; email: string }, ticketId: string) =>
      db.ticketTransfer.create({
        data: {
          ticketId,
          eventId: event.id,
          fromUserId: from.id,
          fromHolderName: "Nome do remetente",
          fromHolderEmail: from.id === me.id ? "eu@test.local" : "outra@test.local",
          toUserId: to.id,
          toEmail: to.email,
          toHolderName: "Nome do destinatário",
          tokenHash: sha256(randomUUID()),
          expiresAt: new Date(Date.now() + 86_400_000),
          createdById: from.id,
          requestIp: "192.0.2.44",
        },
      });
    await transfer(me, other, myTicket.id);
    await transfer(other, me, theirTicket.id);

    currentUser = me;
    const res = await exportData();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="meus-dados-evento-brasil-/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = await res.text();
    const data = JSON.parse(text);

    expect(data.profile).toMatchObject({ id: me.id, email: "eu@test.local", name: "Comprador" });
    expect(data.orders.map((o: { code: string }) => o.code)).toEqual([mine.publicCode]);
    expect(data.orders[0].items[0]).toMatchObject({ quantity: 2 });
    expect(data.orders[0].payments[0]).toMatchObject({ method: "PIX", status: "PAID" });
    expect(data.tickets).toHaveLength(2);
    expect(data.termsAcceptances.map((a: { kind: string }) => a.kind).sort()).toEqual(["BUYER", "PRIVACY"]);
    expect(data.transfers.map((t: { direction: string }) => t.direction).sort()).toEqual(["RECEIVED", "SENT"]);
    const received = data.transfers.find((t: { direction: string }) => t.direction === "RECEIVED");
    expect(received).toMatchObject({ toEmail: null, requestIp: null });

    // Nada de segredos nem de dados da outra conta (o e-mail dela só aparece como o
    // destinatário que eu mesmo informei na transferência enviada).
    expect(text.split("outra@test.local")).toHaveLength(2);
    for (const leak of [me.passwordHash, myTicket.validationToken, other.id, theirs.publicCode, "Nome do remetente", "pixCopyPaste", "tokenHash", "passwordHash"])
      expect(text).not.toContain(leak);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "user.data_exported", actorUserId: me.id } });
    expect(log).toMatchObject({ entityType: "User", entityId: me.id });
    expect(JSON.stringify(log.metadata)).not.toContain("eu@test.local");
  });

  it("tem limite de exportações por conta", async () => {
    currentUser = await makeUser();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await exportData()).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
