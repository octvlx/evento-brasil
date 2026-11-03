// Limite de tentativas no banco (RateLimitBucket): vale entre instâncias e
// reinícios. Inclui os limites de pedido e pagamento (Decreto 13.108, R4; L4a),
// antes testados contra o contador em memória.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertCanCreateOrder, assertCanStartPayment, ORDER_RATE_LIMITS } from "@/features/orders/limits";
import { failureLimiter, rateLimit } from "@/server/rate-limit";
import { runRetentionPurge } from "@/server/services/retention-purge";
import { db, resetDb } from "../support/fixtures";

const uid = () => `user-${randomUUID()}`;
const ip = () => `ip-${randomUUID()}`;
const T0 = new Date("2026-11-03T12:00:00.000Z");

async function repeat(n: number, fn: () => Promise<unknown>) {
  for (let i = 0; i < n; i++) await fn();
}

beforeEach(async () => {
  await resetDb();
  // Só o relógio do JS; timers reais, para não travar o driver do Postgres.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("rateLimit no banco", () => {
  it("guarda a chave como HMAC, nunca em claro", async () => {
    await rateLimit("login:203.0.113.7", 5, 60_000, db);
    const rows = await db.rateLimitBucket.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].key).not.toContain("203.0.113.7");
    expect(rows[0]).toMatchObject({ count: 1, resetAt: new Date(T0.getTime() + 60_000) });
  });

  it("chamadas simultâneas: exatamente `limit` passam", async () => {
    const key = `concorrencia:${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => rateLimit(key, 10, 60_000, db)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "RATE_LIMITED")).toBe(true);
    expect((await db.rateLimitBucket.findFirstOrThrow()).count).toBe(25);
  });

  it("failureLimiter: só falhas contam, sucesso zera, janela expira", async () => {
    const key = `login:${ip()}`;
    await repeat(3, () => failureLimiter.fail(key, 60_000));
    await expect(failureLimiter.assert(key, 3, 60_000)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    await expect(failureLimiter.assert(key, 3, 60_000)).resolves.toBeUndefined();
    // Nova janela recomeça do zero ao falhar de novo.
    await failureLimiter.fail(key, 60_000);
    await expect(failureLimiter.assert(key, 2, 60_000)).resolves.toBeUndefined();
    await failureLimiter.fail(key, 60_000);
    await expect(failureLimiter.assert(key, 2, 60_000)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await failureLimiter.reset(key);
    await expect(failureLimiter.assert(key, 2, 60_000)).resolves.toBeUndefined();
  });

  it("o expurgo programado remove só janelas vencidas", async () => {
    await rateLimit("curta", 5, 60_000, db);
    await rateLimit("longa", 5, 60 * 60_000, db);
    const result = await runRetentionPurge(db, new Date(T0.getTime() + 2 * 60_000));
    expect(result.rateLimits).toBe(1);
    expect(await db.rateLimitBucket.count()).toBe(1);
  });
});

describe("limites de pedido e pagamento", () => {
  const { createOrder, startPayment } = ORDER_RATE_LIMITS;

  it("criação de pedido: até o limite por conta, depois RATE_LIMITED com mensagem em pt-BR", async () => {
    const user = uid();
    const client = ip();
    await repeat(createOrder.perUser.limit, () => assertCanCreateOrder(user, client));
    await expect(assertCanCreateOrder(user, client)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Você criou muitos pedidos em pouco tempo. Aguarde alguns minutos e tente novamente.",
    });
    // Trocar de IP não fura o limite da conta.
    await expect(assertCanCreateOrder(user, ip())).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // Outra conta não é afetada.
    await expect(assertCanCreateOrder(uid(), ip())).resolves.toBeUndefined();
  });

  it("criação de pedido: limite por IP vale entre contas diferentes", async () => {
    const client = ip();
    await repeat(createOrder.perClient.limit, () => assertCanCreateOrder(uid(), client));
    await expect(assertCanCreateOrder(uid(), client)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(assertCanCreateOrder(uid(), ip())).resolves.toBeUndefined();
  });

  it("a janela expira e libera novas tentativas", async () => {
    const user = uid();
    const client = ip();
    await repeat(createOrder.perUser.limit, () => assertCanCreateOrder(user, client));
    await expect(assertCanCreateOrder(user, client)).rejects.toThrow();
    vi.setSystemTime(new Date(T0.getTime() + createOrder.perUser.windowMs - 1));
    await expect(assertCanCreateOrder(user, client)).rejects.toThrow();
    vi.setSystemTime(new Date(T0.getTime() + createOrder.perUser.windowMs));
    await expect(assertCanCreateOrder(user, client)).resolves.toBeUndefined();
  });

  it("início de pagamento tem contador próprio, por conta e por IP", async () => {
    const user = uid();
    const client = ip();
    await repeat(createOrder.perUser.limit, () => assertCanCreateOrder(user, client));
    // Pedidos esgotados não bloqueiam o pagamento.
    await repeat(startPayment.perUser.limit, () => assertCanStartPayment(user, client));
    await expect(assertCanStartPayment(user, client)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Muitas tentativas de pagamento em pouco tempo. Aguarde alguns minutos e tente novamente.",
    });

    const shared = ip();
    await repeat(startPayment.perClient.limit, () => assertCanStartPayment(uid(), shared));
    await expect(assertCanStartPayment(uid(), shared)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("limites por IP são mais folgados que por conta (redes compartilhadas)", () => {
    expect(createOrder.perClient.limit).toBeGreaterThan(createOrder.perUser.limit);
    expect(startPayment.perClient.limit).toBeGreaterThan(startPayment.perUser.limit);
  });
});
