import "server-only";
import { AppError } from "./errors";

// Limitador em memória por processo (janela fixa). Suficiente para uma única
// instância; com várias instâncias, substituir por Redis/Postgres.
const buckets = new Map<string, { count: number; resetAt: number }>();

function bucket(key: string, windowMs: number) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }
  return b;
}

const limited = () => new AppError("RATE_LIMITED", "Muitas tentativas. Aguarde alguns minutos e tente novamente.");

/** Conta toda chamada (ex.: cadastro, leituras de check-in). */
export function rateLimit(key: string, limit: number, windowMs: number) {
  const b = bucket(key, windowMs);
  b.count++;
  if (b.count > limit) throw limited();
}

/** Para logins: só falhas contam; sucesso zera o contador. */
export const failureLimiter = {
  assert(key: string, limit: number, windowMs: number) {
    if (bucket(key, windowMs).count >= limit) throw limited();
  },
  fail(key: string, windowMs: number) {
    bucket(key, windowMs).count++;
  },
  reset(key: string) {
    buckets.delete(key);
  },
};
