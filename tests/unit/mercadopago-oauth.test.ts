import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db";
import type { Actor } from "@/server/auth/permissions";
let mp: typeof import("@/server/payments/mercadopago-oauth");
const actor: Actor = { id: "owner", status: "ACTIVE", platformRole: "USER" };
function fakeDb(role = "OWNER", status = "APPROVED") {
  const client = {
    user: { findUnique: vi.fn(async () => ({ status: "ACTIVE" })) },
    organizationMember: { findUnique: vi.fn(async () => ({ role, organization: { status } })) },
    mercadoPagoOAuthState: { create: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
    mercadoPagoAccount: { upsert: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn(async () => ({ status })) },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
  };
  return { mock: client, db: client as unknown as Db };
}
const tokens = { access_token: "secret-access", refresh_token: "secret-refresh", user_id: 123, token_type: "bearer", expires_in: 3600, scope: "offline_access payments write" };
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("MERCADO_PAGO_CLIENT_ID", "client-id"); vi.stubEnv("MERCADO_PAGO_CLIENT_SECRET", "test-secret");
  vi.stubEnv("MERCADO_PAGO_TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
  mp = await import("@/server/payments/mercadopago-oauth");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("Mercado Pago OAuth security", () => {
  it("binds an expiring encrypted PKCE cookie to actor, state and redirect", async () => {
    const { db, mock } = fakeDb(); const flow = await mp.beginConnection(db, actor, "org-a");
    const url = new URL(flow.url); const state = url.searchParams.get("state")!;
    expect(url.origin).toBe("https://auth.mercadopago.com.br");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/mercadopago/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(mock.mercadoPagoOAuthState.create.mock.calls[0][0].data.stateHash).not.toBe(state);
    expect(mp.readFlow(flow.cookie, state, actor.id).organizationId).toBe("org-a");
    expect(flow.cookie).not.toContain(state);
    for (const [cookie, nonce, owner] of [[flow.cookie, "wrong", actor.id], [flow.cookie, state, "other"], [flow.cookie + "x", state, actor.id]]) expect(() => mp.readFlow(cookie, nonce, owner)).toThrow();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601000);
    expect(() => mp.readFlow(flow.cookie, state, actor.id)).toThrow();
  });
  it.each(["FINANCE", "EVENT_MANAGER", "CHECKIN_STAFF"])("rejects role %s", async role => {
    const { db } = fakeDb(role); await expect(mp.beginConnection(db, actor, "org")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects an unapproved organization", async () => {
    await expect(mp.beginConnection(fakeDb("OWNER", "PENDING_REVIEW").db, actor, "org")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("encrypts both tokens and exchanges code only after state consumption", async () => {
    const { db, mock } = fakeDb(); const flow = await mp.beginConnection(db, actor, "org");
    const state = new URL(flow.url).searchParams.get("state")!;
    const fetcher = vi.fn(async () => Response.json(tokens)); vi.stubGlobal("fetch", fetcher);
    await expect(mp.finishConnection(db, actor, flow.cookie, state, "code")).resolves.toBe("connected");
    const data = mock.mercadoPagoAccount.upsert.mock.calls[0][0].create;
    expect(data.accessTokenEncrypted).toMatch(/^mp1\./); expect(data.accessTokenEncrypted).not.toContain(tokens.access_token);
    expect(data.refreshTokenEncrypted).not.toContain(tokens.refresh_token);
    const call = vi.mocked(fetch).mock.calls[0];
    expect((call[1]!.body as URLSearchParams).get("code_verifier")).toBe(mp.readFlow(flow.cookie, state, actor.id).verifier);
    mock.mercadoPagoOAuthState.updateMany.mockResolvedValue({ count: 0 });
    await expect(mp.finishConnection(db, actor, flow.cookie, state, "code")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [undefined, "false"],
    ["true", "true"],
  ])("sends test_token=%s→%s in the code exchange (sandbox credentials only when enabled)", async (flag, expected) => {
    if (flag) vi.stubEnv("MERCADO_PAGO_OAUTH_TEST_TOKEN", flag);
    vi.resetModules();
    mp = await import("@/server/payments/mercadopago-oauth");
    const { db } = fakeDb(); const flow = await mp.beginConnection(db, actor, "org");
    const state = new URL(flow.url).searchParams.get("state")!;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(tokens)));
    await expect(mp.finishConnection(db, actor, flow.cookie, state, "code")).resolves.toBe("connected");
    const body = vi.mocked(fetch).mock.calls[0][1]!.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("test_token")).toBe(expected);
  });
  it("consumes denied consent without calling the provider", async () => {
    const { db, mock } = fakeDb(); const flow = await mp.beginConnection(db, actor, "org");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(await mp.finishConnection(db, actor, flow.cookie, new URL(flow.url).searchParams.get("state")!, null, true)).toBe("denied");
    expect(mock.mercadoPagoOAuthState.updateMany).toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([Response.json({ error: "invalid_client", secret: "DO-NOT-LEAK" }, { status: 400 }), Response.json({ ...tokens, scope: "payments" }), Response.json({ ...tokens, expires_in: -1 })])("sanitizes provider errors or invalid token responses", async response => {
    const { db, mock } = fakeDb(); const flow = await mp.beginConnection(db, actor, "org"); vi.stubGlobal("fetch", vi.fn(async () => response.clone()));
    await expect(mp.finishConnection(db, actor, flow.cookie, new URL(flow.url).searchParams.get("state")!, "code")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(mock.mercadoPagoAccount.upsert).not.toHaveBeenCalled();
  });
  it("rotates both tokens, sanitizes transient failures and persists revocation", async () => {
    const { db, mock } = fakeDb(); const flow = await mp.beginConnection(db, actor, "org");
    const fetcher = vi.fn(async () => Response.json(tokens)); vi.stubGlobal("fetch", fetcher);
    await mp.finishConnection(db, actor, flow.cookie, new URL(flow.url).searchParams.get("state")!, "code");
    const saved = mock.mercadoPagoAccount.upsert.mock.calls[0][0].create;
    mock.mercadoPagoAccount.findUnique.mockResolvedValue({ ...saved, revokedAt: null, tokenExpiresAt: new Date(0) });
    expect(await mp.getMercadoPagoAccessToken(db, "org")).toBe(tokens.access_token);
    expect(mock.mercadoPagoAccount.update).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await expect(mp.getMercadoPagoAccessToken(db, "org")).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(mock.mercadoPagoAccount.update.mock.calls[1][0].data.revokedAt).toBeInstanceOf(Date);
    fetcher.mockRejectedValue(new Error("DO-NOT-LEAK"));
    await expect(mp.getMercadoPagoAccessToken(db, "org")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
