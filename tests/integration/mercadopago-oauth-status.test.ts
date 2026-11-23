// Com o Mercado Pago como provedor ativo, a conta de recebimento da organização segue a
// autorização OAuth: conectada ao autorizar, não conectada quando a autorização é revogada.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, makeOrg, makeUser, resetDb } from "../support/fixtures";
import { beginConnection, finishConnection, getMercadoPagoAccessToken } from "@/server/payments/mercadopago-oauth";

vi.hoisted(() => {
  process.env.MERCADO_PAGO_CLIENT_ID = "integration-client";
  process.env.MERCADO_PAGO_CLIENT_SECRET = "test-only-client-secret";
  process.env.MERCADO_PAGO_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});
vi.mock("@/server/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/env")>();
  return { ...actual, env: () => ({ ...actual.env(), PAYMENT_PROVIDER: "mercadopago" as const }) };
});

const tokens = { access_token: "integration-access", refresh_token: "integration-refresh", user_id: 789, token_type: "bearer", expires_in: 3600, scope: "offline_access payments write" };

beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("status da conta de recebimento com o Mercado Pago ativo", () => {
  it("autorizar conecta a organização; revogar desconecta", async () => {
    const user = await makeUser();
    const org = await makeOrg(user);
    await db.organization.update({ where: { id: org.id }, data: { paymentProvider: null, paymentAccountStatus: "NOT_CONNECTED", paymentAccountExternalId: null } });
    const flow = await beginConnection(db, user, org.id);
    const state = new URL(flow.url).searchParams.get("state")!;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(tokens)));

    await expect(finishConnection(db, user, flow.cookie, state, "code")).resolves.toBe("connected");
    expect(await db.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({
      paymentProvider: "mercadopago",
      paymentAccountStatus: "CONNECTED",
      paymentAccountExternalId: "789",
    });

    // Renovação recusada (invalid_grant) revoga a autorização e a conta volta a "não conectada".
    await db.mercadoPagoAccount.update({ where: { organizationId: org.id }, data: { tokenExpiresAt: new Date(0) } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })));
    await expect(getMercadoPagoAccessToken(db, org.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).paymentAccountStatus).toBe("NOT_CONNECTED");
  });
});
