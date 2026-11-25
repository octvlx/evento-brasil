import "server-only";
import { db as defaultDb, type Db } from "../db";
import { AppError } from "../errors";
import { failureLimiter } from "../rate-limit";

// Limites de falhas no login com senha. Só falhas contam (failureLimiter). Três chaves:
// - IP + e-mail: o limite curto de sempre (digitação errada, robô simples);
// - conta (e-mail, de qualquer IP): teto contra tentativas distribuídas em muitos IPs;
// - IP (qualquer e-mail): teto contra um IP testando muitas contas.
// O sucesso zera IP+e-mail e a conta, nunca o do IP: senão quem tem uma conta válida
// zeraria o próprio IP entre as tentativas contra contas alheias.

const MINUTE = 60_000;
export const LOGIN_LIMITS = {
  ipEmail: { max: 8, windowMs: 15 * MINUTE },
  account: { max: 20, windowMs: 60 * MINUTE },
  ip: { max: 40, windowMs: 15 * MINUTE },
} as const;

const normalize = (email: string) => email.trim().toLowerCase();
// IP desconhecido (sem cabeçalho do proxy): a chave só por IP seria uma só para todos e
// viraria bloqueio global, então ela é pulada; IP+e-mail e conta continuam valendo.
const keys = (ip: string | null, email: string) => ({
  ipEmail: `login:${ip ?? "local"}:${normalize(email)}`,
  account: `login-account:${normalize(email)}`,
  ip: ip ? `login-ip:${ip}` : null,
});

export const ACCOUNT_LOCKED_MESSAGE =
  "Muitas tentativas de acesso a esta conta. Aguarde até 1 hora ou use “Esqueci minha senha”.";

export async function assertLoginAllowed(ip: string | null, email: string, client: Db = defaultDb) {
  const k = keys(ip, email);
  await failureLimiter.assert(k.ipEmail, LOGIN_LIMITS.ipEmail.max, LOGIN_LIMITS.ipEmail.windowMs, client);
  if (k.ip) await failureLimiter.assert(k.ip, LOGIN_LIMITS.ip.max, LOGIN_LIMITS.ip.windowMs, client);
  try {
    await failureLimiter.assert(k.account, LOGIN_LIMITS.account.max, LOGIN_LIMITS.account.windowMs, client);
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") throw new AppError("RATE_LIMITED", ACCOUNT_LOCKED_MESSAGE);
    throw err;
  }
}

export async function recordLoginFailure(ip: string | null, email: string, client: Db = defaultDb) {
  const k = keys(ip, email);
  await failureLimiter.fail(k.ipEmail, LOGIN_LIMITS.ipEmail.windowMs, client);
  await failureLimiter.fail(k.account, LOGIN_LIMITS.account.windowMs, client);
  if (k.ip) await failureLimiter.fail(k.ip, LOGIN_LIMITS.ip.windowMs, client);
}

export async function recordLoginSuccess(ip: string | null, email: string, client: Db = defaultDb) {
  const k = keys(ip, email);
  await failureLimiter.reset(k.ipEmail, client);
  await failureLimiter.reset(k.account, client);
}

/** Senha redefinida pelo link do e-mail: o titular provou a posse, a conta volta a aceitar login. */
export async function clearAccountLoginLimit(email: string, client: Db = defaultDb) {
  await failureLimiter.reset(keys(null, email).account, client);
}
