import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeOrg, makeUser, resetDb } from "../support/fixtures";
import { beginConnection, finishConnection, getMercadoPagoAccessToken } from "@/server/payments/mercadopago-oauth";
vi.hoisted(() => {
  process.env.MERCADO_PAGO_CLIENT_ID = "integration-client";
  process.env.MERCADO_PAGO_CLIENT_SECRET = "test-only-client-secret";
  process.env.MERCADO_PAGO_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});
const tokens = { access_token: "integration-access", refresh_token: "integration-refresh", user_id: 789, token_type: "bearer", expires_in: 3600, scope: "offline_access payments write" };
beforeEach(async () => { await resetDb(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function setup() {
  const user = await makeUser(); const org = await makeOrg(user);
  const flow = await beginConnection(db, user, org.id);
  const state = new URL(flow.url).searchParams.get("state")!;
  return { user, org, flow, state };
}
describe("Mercado Pago OAuth PostgreSQL", () => {
  it("allows exactly one concurrent callback and preserves simulated payments", async () => {
    const { user, org, flow, state } = await setup();
    const fetcher = vi.fn(async () => Response.json(tokens)); vi.stubGlobal("fetch", fetcher);
    const results = await Promise.allSettled([finishConnection(db, user, flow.cookie, state, "code"), finishConnection(db, user, flow.cookie, state, "code")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const account = await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(account.accessTokenEncrypted).not.toContain(tokens.access_token);
    expect(account.refreshTokenEncrypted).not.toContain(tokens.refresh_token);
    expect(await getMercadoPagoAccessToken(db, org.id)).toBe(tokens.access_token);
    const savedOrg = await db.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(savedOrg.paymentAccountStatus).toBe("SIMULATED"); expect(savedOrg.paymentProvider).toBe("simulated");
  });
  it("rejects expired state, another user and permission removed after connect", async () => {
    const { user, org, flow, state } = await setup(); const stranger = await makeUser();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(finishConnection(db, stranger, flow.cookie, state, "code")).rejects.toThrow();
    await db.organizationMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: user.id } }, data: { role: "FINANCE" } });
    await expect(finishConnection(db, user, flow.cookie, state, "code")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db.organizationMember.update({ where: { organizationId_userId: { organizationId: org.id, userId: user.id } }, data: { role: "OWNER" } });
    await db.mercadoPagoOAuthState.updateMany({ data: { expiresAt: new Date(0) } });
    await expect(finishConnection(db, user, flow.cookie, state, "code")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(await db.mercadoPagoAccount.count()).toBe(0);
  });
  it("serializes concurrent refresh and persists rotated credentials", async () => {
    const { user, org, flow, state } = await setup();
    const fetcher = vi.fn(async () => Response.json(tokens)); vi.stubGlobal("fetch", fetcher);
    await finishConnection(db, user, flow.cookie, state, "code");
    await db.mercadoPagoAccount.update({ where: { organizationId: org.id }, data: { tokenExpiresAt: new Date(0) } });
    fetcher.mockClear(); fetcher.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return Response.json({ ...tokens, access_token: "rotated-access", refresh_token: "rotated-refresh" });
    });
    expect(await Promise.all([getMercadoPagoAccessToken(db, org.id), getMercadoPagoAccessToken(db, org.id)])).toEqual(["rotated-access", "rotated-access"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const account = await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(account.refreshTokenEncrypted).not.toContain("rotated-refresh");
  });
  it("commits revocation after invalid_grant and refuses subsequent use", async () => {
    const { user, org, flow, state } = await setup();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(tokens)));
    await finishConnection(db, user, flow.cookie, state, "code");
    await db.mercadoPagoAccount.update({ where: { organizationId: org.id }, data: { tokenExpiresAt: new Date(0) } });
    const fetcher = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })); vi.stubGlobal("fetch", fetcher);
    await expect(getMercadoPagoAccessToken(db, org.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } })).revokedAt).not.toBeNull();
    await expect(getMercadoPagoAccessToken(db, org.id)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
