import "server-only";
import { hashToken } from "./crypto";
import { db as defaultDb, type Db } from "./db";
import { AppError } from "./errors";

// Limitador com janela fixa guardado no Postgres (tabela RateLimitBucket), para
// valer entre instâncias e sobreviver a reinícios. A chave lógica vira HMAC: o
// banco não guarda IP nem id em claro. Janelas vencidas saem no expurgo programado.

const limited = () => new AppError("RATE_LIMITED", "Muitas tentativas. Aguarde alguns minutos e tente novamente.");

/**
 * Soma 1 ao contador da chave e devolve o total da janela atual. Um único
 * INSERT ... ON CONFLICT: chamadas simultâneas nunca se perdem nem se duplicam.
 */
async function hit(client: Db, key: string, windowMs: number): Promise<number> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);
  const rows = await client.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
    VALUES (${hashToken(key)}, 1, ${resetAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now} THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
      "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now} THEN EXCLUDED."resetAt" ELSE "RateLimitBucket"."resetAt" END
    RETURNING "count"`;
  return Number(rows[0].count);
}

/** Conta toda chamada (ex.: cadastro, leituras de check-in). */
export async function rateLimit(key: string, limit: number, windowMs: number, client: Db = defaultDb) {
  if ((await hit(client, key, windowMs)) > limit) throw limited();
}

/** Para logins: só falhas contam; sucesso zera o contador. */
export const failureLimiter = {
  async assert(key: string, limit: number, _windowMs: number, client: Db = defaultDb) {
    const bucket = await client.rateLimitBucket.findUnique({ where: { key: hashToken(key) } });
    if (bucket && bucket.resetAt > new Date() && bucket.count >= limit) throw limited();
  },
  async fail(key: string, windowMs: number, client: Db = defaultDb) {
    await hit(client, key, windowMs);
  },
  async reset(key: string, client: Db = defaultDb) {
    await client.rateLimitBucket.deleteMany({ where: { key: hashToken(key) } });
  },
};
