// Seed de demonstração num banco descartável próprio (não o banco compartilhado
// dos testes): roda duas vezes e confere invariantes e as linhas da Fase 3.
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { PrismaClient } from "@/generated/prisma/client";
import { createPrismaClient } from "@/server/db";
import { checkFinancialInvariants } from "@/server/services/reconciliation";

const base = new URL(process.env.DATABASE_URL!);
const seedDbName = `evento_seed_${process.pid}`;
const seedUrl = new URL(base);
seedUrl.pathname = `/${seedDbName}`;

async function admin(sql: string) {
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const env = { ...process.env, DATABASE_URL: seedUrl.toString() };
const runSeed = () => execSync("npx tsx --conditions=react-server prisma/seed.ts", { env, encoding: "utf8", stdio: "pipe" });

let db: PrismaClient;
let firstOutput = "";
let secondOutput = "";

beforeAll(async () => {
  await admin(`DROP DATABASE IF EXISTS "${seedDbName}"`);
  await admin(`CREATE DATABASE "${seedDbName}"`);
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  firstOutput = runSeed();
  secondOutput = runSeed();
  db = createPrismaClient(seedUrl.toString());
}, 300_000);

afterAll(async () => {
  await db?.$disconnect();
  await admin(`DROP DATABASE IF EXISTS "${seedDbName}" WITH (FORCE)`);
});

describe("seed de demonstração", () => {
  it("roda uma vez e a segunda execução não altera nada", async () => {
    expect(firstOutput).toMatch(/Seed concluído/);
    expect(secondOutput).toMatch(/já contém o seed/);
    expect(await db.user.count({ where: { email: "admin@demo.eventobrasil.test" } })).toBe(1);
    expect(await db.termsVersion.count()).toBe(3);
  });

  it("mantém os invariantes financeiros", async () => {
    expect(await checkFinancialInvariants(db)).toEqual([]);
  });

  it("cria os termos v1 como rascunho e os aceites das contas demo", async () => {
    const versions = await db.termsVersion.findMany({ orderBy: { kind: "asc" } });
    expect(versions.map((v) => [v.kind, v.version, v.isDraft])).toEqual([
      ["BUYER", "v1", true],
      ["ORGANIZER", "v1", true],
      ["PRIVACY", "v1", true],
    ]);
    const demoUsers = await db.user.findMany({ where: { isDemoAccount: true }, select: { id: true } });
    for (const u of demoUsers) {
      const kinds = await db.termsAcceptance.findMany({ where: { userId: u.id, context: "SIGNUP" }, select: { termsVersion: { select: { kind: true } } } });
      expect(kinds.map((k) => k.termsVersion.kind).sort()).toEqual(["BUYER", "PRIVACY"]);
    }
    expect(await db.termsAcceptance.count({ where: { context: "ORGANIZER_SIGNUP", termsVersion: { kind: "ORGANIZER" } } })).toBe(await db.organization.count());
    const customer = await db.user.findUniqueOrThrow({ where: { email: "cliente@demo.eventobrasil.test" } });
    expect(await db.termsAcceptance.count({ where: { userId: customer.id, context: "CHECKOUT" } })).toBe(await db.order.count({ where: { userId: customer.id } }));
  });

  it("tem evento com limite por conta e alteração relevante com janela aberta em evento com pedido pago", async () => {
    const limited = await db.event.findMany({ where: { maxTicketsPerAccount: { not: null } } });
    expect(limited).toHaveLength(1);
    const change = await db.eventChange.findFirstOrThrow({ where: { relevant: true, refundUntil: { gt: new Date() } } });
    const paidBefore = await db.order.count({ where: { eventId: change.eventId, status: "PAID", paidAt: { lt: change.createdAt } } });
    expect(paidBefore).toBeGreaterThan(0);
    const event = await db.event.findUniqueOrThrow({ where: { id: change.eventId } });
    expect((change.after as { startsAt: string }).startsAt).toBe(event.startsAt.toISOString());
  });

  it("tem transferência aceita (titular atualizado) e uma pendente", async () => {
    const accepted = await db.ticketTransfer.findFirstOrThrow({ where: { status: "ACCEPTED" }, include: { ticket: true } });
    expect(accepted.ticket.holderUserId).toBe(accepted.toUserId);
    expect(accepted.ticket.userId).toBe(accepted.fromUserId);
    expect(accepted.previousTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.auditLog.count({ where: { action: "ticket.transfer.accepted", entityId: accepted.id } })).toBe(1);
    const pending = await db.ticketTransfer.findFirstOrThrow({ where: { status: "PENDING" }, include: { ticket: true } });
    expect(pending.toUserId).toBeNull();
    expect(pending.ticket.holderUserId).toBe(pending.fromUserId);
  });

  it("tem um pedido de cancelamento aberto com protocolo válido", async () => {
    const requests = await db.cancellationRequest.findMany();
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("OPEN");
    expect(requests[0].protocol).toMatch(/^CAN-[0-9]{8}-[0-9A-HJKMNP-TV-Z]{6}$/);
  });
});
