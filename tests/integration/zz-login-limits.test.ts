// Limites de falhas no login com senha: IP+e-mail (curto), por conta (contra tentativas
// distribuídas em muitos IPs) e por IP (contra um IP testando muitas contas).
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_LOCKED_MESSAGE,
  assertLoginAllowed,
  LOGIN_LIMITS,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/server/auth/login-limits";
import { hashPassword } from "@/server/auth/password";
import * as outbox from "@/server/email/outbox";
import { requestPasswordReset, resetPassword } from "@/server/services/password-reset";
import { db, makeUser, resetDb } from "../support/fixtures";

const T0 = new Date("2026-11-24T12:00:00.000Z");
const ip = () => `203.0.113.${Math.floor(Math.random() * 250)}-${randomUUID().slice(0, 8)}`;
const email = () => `alvo-${randomUUID()}@test.local`;

beforeEach(async () => {
  await resetDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Uma tentativa errada como a ação de login faz: confere o limite e registra a falha. */
async function wrongAttempt(fromIp: string | null, target: string) {
  await assertLoginAllowed(fromIp, target, db);
  await recordLoginFailure(fromIp, target, db);
}

describe("limites do login com senha", () => {
  it("tentativas de muitos IPs contra a mesma conta param no teto da conta, com mensagem própria", async () => {
    const target = email();
    // Cada IP fica abaixo do limite curto de IP+e-mail.
    for (let i = 0; i < LOGIN_LIMITS.account.max; i++) await wrongAttempt(ip(), target);
    await expect(assertLoginAllowed(ip(), target, db)).rejects.toMatchObject({ code: "RATE_LIMITED", message: ACCOUNT_LOCKED_MESSAGE });
    // Outras contas não são afetadas.
    await expect(assertLoginAllowed(ip(), email(), db)).resolves.toBeUndefined();
    // A janela de 1 hora expira.
    vi.setSystemTime(new Date(T0.getTime() + LOGIN_LIMITS.account.windowMs));
    await expect(assertLoginAllowed(ip(), target, db)).resolves.toBeUndefined();
  });

  it("um IP testando muitas contas para no teto do IP", async () => {
    const attacker = ip();
    for (let i = 0; i < LOGIN_LIMITS.ip.max; i++) await wrongAttempt(attacker, email());
    await expect(assertLoginAllowed(attacker, email(), db)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(assertLoginAllowed(ip(), email(), db)).resolves.toBeUndefined();
  });

  it("entrar na própria conta não zera o teto do IP", async () => {
    const attacker = ip();
    const own = email();
    for (let i = 0; i < LOGIN_LIMITS.ip.max - 1; i++) await wrongAttempt(attacker, email());
    await recordLoginSuccess(attacker, own, db);
    await wrongAttempt(attacker, email());
    await expect(assertLoginAllowed(attacker, email(), db)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("sem IP identificado não há bloqueio global: só IP+e-mail e conta contam", async () => {
    for (let i = 0; i < LOGIN_LIMITS.ip.max + 5; i++) await wrongAttempt(null, email());
    await expect(assertLoginAllowed(null, email(), db)).resolves.toBeUndefined();
  });

  it("o limite curto de IP+e-mail continua valendo e o sucesso zera ele e o da conta", async () => {
    const from = ip();
    const target = email();
    for (let i = 0; i < LOGIN_LIMITS.ipEmail.max; i++) await wrongAttempt(from, target);
    await expect(assertLoginAllowed(from, target, db)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await recordLoginSuccess(from, target, db);
    await expect(assertLoginAllowed(from, target, db)).resolves.toBeUndefined();
  });

  it("e-mail com maiúsculas ou espaços conta para a mesma conta", async () => {
    const target = email();
    for (let i = 0; i < LOGIN_LIMITS.account.max; i++) await wrongAttempt(ip(), i % 2 ? ` ${target.toUpperCase()} ` : target);
    await expect(assertLoginAllowed(ip(), target, db)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("redefinir a senha pelo link do e-mail libera a conta bloqueada", async () => {
    const user = await makeUser();
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword("Antiga#Senha77") } });
    for (let i = 0; i < LOGIN_LIMITS.account.max; i++) await wrongAttempt(ip(), user.email);
    await expect(assertLoginAllowed(ip(), user.email, db)).rejects.toMatchObject({ code: "RATE_LIMITED" });

    const queue = vi.spyOn(outbox, "enqueueEmail");
    await requestPasswordReset(db, user.email, { ip: "198.51.100.10" });
    const message = queue.mock.calls.at(-1)?.[1].message;
    const url = new URL(message!.text.match(/https?:\/\/[^\s<"]+/)![0]);
    const token = new URLSearchParams(url.hash.slice(1)).get("token")!;
    expect(await resetPassword(db, { token, password: "Nova#Chave2580", confirmation: "Nova#Chave2580" })).toEqual({ reset: true });

    await expect(assertLoginAllowed(ip(), user.email, db)).resolves.toBeUndefined();
  });
});

describe("aviso ao titular quando a conta bloqueia", () => {
  const notices = () => db.emailOutbox.findMany({ where: { template: "ACCOUNT_LOGIN_LOCKED" } });

  it("um e-mail na falha que bloqueia, nenhum antes nem nas seguintes da mesma janela", async () => {
    const user = await makeUser();
    for (let i = 0; i < LOGIN_LIMITS.account.max - 1; i++) await wrongAttempt(ip(), user.email);
    expect(await notices()).toHaveLength(0);
    await wrongAttempt(ip(), user.email);
    const [mail] = await notices();
    expect(mail.recipient).toBe(user.email);
    // Já bloqueada: novas tentativas são recusadas antes de contar, sem novo aviso.
    await expect(wrongAttempt(ip(), user.email)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await recordLoginFailure(ip(), user.email, db);
    expect(await notices()).toHaveLength(1);
  });

  it("o aviso não leva senha nem IP e aponta para a redefinição", async () => {
    const user = await makeUser();
    const from = ip();
    for (let i = 0; i < LOGIN_LIMITS.account.max; i++) await recordLoginFailure(i === 0 ? from : ip(), user.email, db);
    const queue = await db.emailOutbox.findFirstOrThrow({ where: { template: "ACCOUNT_LOGIN_LOCKED" } });
    const raw = JSON.stringify(queue);
    expect(raw).not.toContain(from);
    const { accountLockedEmail } = await import("@/server/email/templates");
    const msg = accountLockedEmail("password", "https://app.test/esqueci-minha-senha", { google: false });
    expect(msg.text).toContain("https://app.test/esqueci-minha-senha");
    expect(msg.subject).toContain("Tentativas de acesso bloqueadas");
  });

  it("e-mail sem conta, conta suspensa ou só do Google: nenhum aviso", async () => {
    for (let i = 0; i < LOGIN_LIMITS.account.max; i++) await recordLoginFailure(ip(), "ninguem-" + email(), db);
    const suspended = await makeUser();
    await db.user.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });
    const google = await makeUser();
    await db.user.update({ where: { id: google.id }, data: { googleSubject: "google-sub-" + google.id } });
    for (const target of [suspended.email, google.email])
      for (let i = 0; i < LOGIN_LIMITS.account.max; i++) await recordLoginFailure(ip(), target, db);
    expect(await notices()).toHaveLength(0);
  });
});
