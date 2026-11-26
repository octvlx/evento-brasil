// Desconexão da conta Mercado Pago da organização (configurações do organizador): quem pode,
// o que apaga, quando é recusada (dinheiro em andamento que depende do token), o checkout
// depois de desconectar e a reconexão.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeBuyerReady } from "../support/buyer-ready";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";
import { hashPassword } from "@/server/auth/password";
import { createOrder } from "@/server/services/orders";
import {
  beginConnection,
  disconnectMercadoPago,
  finishConnection,
  getMercadoPagoAccessToken,
  mercadoPagoDisconnectBlockers,
} from "@/server/payments/mercadopago-oauth";

vi.hoisted(() => {
  process.env.MERCADO_PAGO_CLIENT_ID = "integration-client";
  process.env.MERCADO_PAGO_CLIENT_SECRET = "test-only-client-secret";
  process.env.MERCADO_PAGO_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});
vi.mock("@/server/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/env")>();
  return { ...actual, env: () => ({ ...actual.env(), PAYMENT_PROVIDER: "mercadopago" as const }) };
});

const DAY = 86_400_000;
const PASSWORD = "senha-forte-1";
const tokens = { access_token: "integration-access", refresh_token: "integration-refresh", user_id: 789, token_type: "bearer", expires_in: 3600, scope: "offline_access payments write" };
const mpCheckout = { providerIsSimulated: false, providerId: "mercadopago" } as const;

beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.MFA_REQUIRED;
});

async function withPassword(user: { id: string }) {
  return db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
}

async function connect(user: Awaited<ReturnType<typeof makeUser>>, orgId: string) {
  const flow = await beginConnection(db, user, orgId);
  const state = new URL(flow.url).searchParams.get("state")!;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(tokens)));
  await expect(finishConnection(db, user, flow.cookie, state, "code")).resolves.toBe("connected");
  vi.unstubAllGlobals();
}

async function setup() {
  const owner = await withPassword(await makeUser());
  const org = await makeOrg(owner);
  await db.organization.update({ where: { id: org.id }, data: { paymentProvider: null, paymentAccountStatus: "NOT_CONNECTED", paymentAccountExternalId: null } });
  await connect(owner, org.id);
  return { owner, org };
}

async function endEvent(eventId: string) {
  const endsAt = new Date(Date.now() - DAY);
  const startsAt = new Date(endsAt.getTime() - 4 * 3_600_000);
  await db.event.update({ where: { id: eventId }, data: { salesStartAt: new Date(startsAt.getTime() - 30 * DAY), salesEndAt: startsAt, startsAt, endsAt } });
}

describe("desconectar a conta Mercado Pago", () => {
  it("só OWNER/ADMIN da organização, com a senha certa; o dono sem 2FA é barrado quando exigido", async () => {
    const { owner, org } = await setup();
    const roles = ["EVENT_MANAGER", "FINANCE", "CHECKIN_STAFF"] as const;
    for (const role of roles) {
      const member = await withPassword(await makeUser());
      await db.organizationMember.create({ data: { organizationId: org.id, userId: member.id, role } });
      await expect(disconnectMercadoPago(db, member, org.id, { password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const outsider = await withPassword(await makeUser());
    await expect(disconnectMercadoPago(db, outsider, org.id, { password: PASSWORD })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(disconnectMercadoPago(db, owner, org.id, { password: "errada" })).rejects.toThrow("Senha incorreta.");
    await expect(disconnectMercadoPago(db, owner, org.id, {})).rejects.toThrow("Senha incorreta.");

    process.env.MFA_REQUIRED = "true";
    await expect(disconnectMercadoPago(db, owner, org.id, { password: PASSWORD })).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    delete process.env.MFA_REQUIRED;

    // Nada mudou.
    expect((await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } })).revokedAt).toBeNull();
    expect(await db.auditLog.count({ where: { action: "mercadopago.disconnected" } })).toBe(0);

    // ADMIN da organização pode.
    const admin = await withPassword(await makeUser());
    await db.organizationMember.create({ data: { organizationId: org.id, userId: admin.id, role: "ADMIN" } });
    await disconnectMercadoPago(db, admin, org.id, { password: PASSWORD });
    expect((await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } })).revokedAt).not.toBeNull();
  });

  it("apaga os tokens, revoga, deixa a conta não conectada e registra na auditoria", async () => {
    const { owner, org } = await setup();
    await disconnectMercadoPago(db, owner, org.id, { password: PASSWORD });

    const account = await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(account).toMatchObject({ accessTokenEncrypted: "", refreshTokenEncrypted: "", mercadoPagoUserId: "789" });
    expect(account.revokedAt).not.toBeNull();
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).paymentAccountStatus).toBe("NOT_CONNECTED");
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "mercadopago.disconnected" } });
    expect(log).toMatchObject({ actorUserId: owner.id, organizationId: org.id, entityType: "MercadoPagoAccount", entityId: account.id });
    expect(log.metadata).toMatchObject({ mercadoPagoUserId: "789" });

    // Nenhum token sai mais da conta, nem por renovação.
    const fetcher = vi.fn(async () => Response.json(tokens));
    vi.stubGlobal("fetch", fetcher);
    await expect(getMercadoPagoAccessToken(db, org.id)).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(fetcher).not.toHaveBeenCalled();

    // Desconectar de novo: nada a desconectar.
    await expect(disconnectMercadoPago(db, owner, org.id, { password: PASSWORD })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("checkout de ingresso pago recusa depois de desconectar (gratuito continua) e volta ao reconectar", async () => {
    const { owner, org } = await setup();
    const event = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 50 }, { priceCents: 0, quantityTotal: 50 }] });
    const [paid, free] = event.ticketTypes;
    const buyer = await makeBuyerReady(await makeUser());

    await disconnectMercadoPago(db, owner, org.id, { password: PASSWORD });
    await expect(createOrder(db, buyer, orderInput(event.id, [{ ticketTypeId: paid.id, quantity: 1 }]), mpCheckout)).rejects.toMatchObject({ code: "SALES_CLOSED" });
    expect(await db.order.count({ where: { eventId: event.id, totalCents: { gt: 0 } } })).toBe(0);
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: paid.id } })).quantityReserved).toBe(0);
    await expect(createOrder(db, buyer, orderInput(event.id, [{ ticketTypeId: free.id, quantity: 1 }]), mpCheckout)).resolves.toMatchObject({ totalCents: 0 });

    await connect(owner, org.id);
    const account = await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(account.revokedAt).toBeNull();
    expect((await db.organization.findUniqueOrThrow({ where: { id: org.id } })).paymentAccountStatus).toBe("CONNECTED");
    expect(await getMercadoPagoAccessToken(db, org.id)).toBe(tokens.access_token);
    await expect(createOrder(db, buyer, orderInput(event.id, [{ ticketTypeId: paid.id, quantity: 1 }]), mpCheckout)).resolves.toMatchObject({ status: "PENDING_PAYMENT" });
  });

  it("recusa com pedido aguardando pagamento (PIX em aberto)", async () => {
    const { owner, org } = await setup();
    const event = await makeEvent(org);
    const buyer = await makeBuyerReady(await makeUser());
    await createOrder(db, buyer, orderInput(event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]), mpCheckout);

    expect(await mercadoPagoDisconnectBlockers(db, org.id)).toEqual(["PENDING_PAYMENTS"]);
    await expect(disconnectMercadoPago(db, owner, org.id, { password: PASSWORD })).rejects.toThrow(/aguardando pagamento/);
    expect((await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } })).revokedAt).toBeNull();
  });

  it("recusa com venda paga de evento que não terminou (reembolso depende da conta); libera depois do evento", async () => {
    const { owner, org } = await setup();
    // Venda paga pelo provedor simulado das fixtures: o que importa é o pedido PAID.
    await db.organization.update({ where: { id: org.id }, data: { paymentProvider: "simulated", paymentAccountStatus: "SIMULATED" } });
    const event = await makeEvent(org);
    await buyAndPay(await makeBuyerReady(await makeUser()), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);

    expect(await mercadoPagoDisconnectBlockers(db, org.id)).toEqual(["UPCOMING_PAID_ORDERS"]);
    await expect(disconnectMercadoPago(db, owner, org.id, { password: PASSWORD })).rejects.toThrow(/reembolso/);

    await endEvent(event.id);
    expect(await mercadoPagoDisconnectBlockers(db, org.id)).toEqual([]);
    await disconnectMercadoPago(db, owner, org.id, { password: PASSWORD });
    expect((await db.mercadoPagoAccount.findUniqueOrThrow({ where: { organizationId: org.id } })).revokedAt).not.toBeNull();
  });
});
