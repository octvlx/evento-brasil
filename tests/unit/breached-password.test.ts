import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envState = vi.hoisted(() => ({ check: true }));
vi.mock("@/server/env", () => ({ env: () => ({ PASSWORD_BREACH_CHECK: envState.check }) }));

import { assertAcceptableNewPassword, isBreachedPassword } from "@/server/auth/breached-password";

const PASSWORD = "Lua-Cheia#Sobre7Mares";
const sha1 = createHash("sha1").update(PASSWORD).digest("hex").toUpperCase();

beforeEach(() => {
  envState.check = true;
  vi.stubGlobal("fetch", vi.fn());
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("senhas vazadas (k-anonimato)", () => {
  it("envia só os 5 primeiros caracteres do SHA-1, com preenchimento, e compara o resto localmente", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(`0000000000000000000000000000000000A:0\r\n${sha1.slice(5)}:42\r\n`));
    expect(await isBreachedPassword(PASSWORD)).toBe(true);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`);
    expect(String(url)).not.toContain(sha1.slice(5));
    expect(new Headers(init?.headers).get("Add-Padding")).toBe("true");
    await expect(assertAcceptableNewPassword(PASSWORD)).rejects.toThrow(/vazamentos/);
  });

  it("linha de preenchimento (contagem 0) não conta como vazada", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(`${sha1.slice(5)}:0\r\n`));
    expect(await isBreachedPassword(PASSWORD)).toBe(false);
  });

  it("falha aberta: serviço fora do ar não bloqueia e não registra a senha", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(Object.assign(new Error("x"), { name: "TimeoutError" }));
    expect(await isBreachedPassword(PASSWORD)).toBeNull();
    await expect(assertAcceptableNewPassword(PASSWORD)).resolves.toBeUndefined();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(PASSWORD);
  });

  it("desligada: não consulta nada", async () => {
    envState.check = false;
    expect(await isBreachedPassword(PASSWORD)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
