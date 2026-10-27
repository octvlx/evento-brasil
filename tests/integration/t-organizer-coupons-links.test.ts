// Fluxo T (ADR 0002, passo 3): o organizador cadastra cupons e links de
// divulgação e vê os relatórios de origem e de uso de cupons. Aplicar o cupom
// no checkout é do passo 2 (pagamentos-financeiro); aqui os pedidos com cupom
// ou link são montados direto no banco.
import { beforeEach, describe, expect, it } from "vitest";
import type { OrgRole } from "@/generated/prisma/client";
import { createCoupon, deleteCoupon, listEventCoupons, setCouponDisabled, updateCoupon } from "@/server/services/coupons";
import { createTrackingLink, listEventTrackingLinks, setTrackingLinkArchived } from "@/server/services/tracking-links";
import { couponUsage, salesBySource } from "@/server/services/reports";
import { checkFinancialInvariants } from "@/server/services/reconciliation";
import { buy, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const forbidden = { code: "FORBIDDEN" };

async function setup(extra: OrgRole[] = []) {
  const owner = await makeUser();
  const members = await Promise.all(extra.map(() => makeUser()));
  const org = await makeOrg(owner, { extraMembers: members.map((u, i) => ({ userId: u.id, role: extra[i] })) });
  const event = await makeEvent(org, {
    tickets: [
      { name: "Inteira", priceCents: 5000, quantityTotal: 50 },
      { name: "Meia", priceCents: 2500, quantityTotal: 50, kind: "HALF_PRICE" },
      { name: "VIP", priceCents: 1000, quantityTotal: 50, kind: "VIP" },
    ],
  });
  return { owner, members, org, event };
}

const percent = (code: string, percentBps: number, extra: Record<string, unknown> = {}) => ({ code, discountType: "PERCENT" as const, percentBps, ...extra });

describe("T — cupons do organizador", () => {
  it("cria cupom (código em maiúsculas), audita e recusa código repetido na organização", async () => {
    const { owner, org, event } = await setup();
    const { coupon, warnings } = await createCoupon(db, owner, event.id, percent("amigos10", 1000, { maxUses: 100, ticketTypeIds: [event.ticketTypes[0].id] }));
    expect(coupon).toMatchObject({ code: "AMIGOS10", organizationId: org.id, eventId: event.id, percentBps: 1000, amountCents: null, maxUses: 100, maxUsesPerUser: null });
    expect(warnings).toEqual([]);
    expect(await db.couponTicketType.count({ where: { couponId: coupon.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: coupon.id, action: "coupon.created" } })).toBe(1);

    // Mesmo código em outro evento da mesma organização: conflito.
    const other = await makeEvent(org);
    await expect(createCoupon(db, owner, other.id, percent("AMIGOS10", 500))).rejects.toMatchObject({ code: "CONFLICT" });
    // Outra organização pode usar o mesmo código.
    const b = await setup();
    await createCoupon(db, b.owner, b.event.id, percent("AMIGOS10", 500));

    const listed = await listEventCoupons(db, owner, event.id);
    expect(listed).toEqual([expect.objectContaining({ code: "AMIGOS10", used: false, disabled: false, ticketTypeIds: [event.ticketTypes[0].id] })]);
  });

  it("recusa meia-entrada, tipo de outro evento e entrada inválida", async () => {
    const { owner, event, org } = await setup();
    const half = event.ticketTypes.find((t) => t.kind === "HALF_PRICE")!;
    await expect(createCoupon(db, owner, event.id, percent("MEIA", 1000, { ticketTypeIds: [half.id] }))).rejects.toMatchObject({ code: "VALIDATION" });
    const other = await makeEvent(org);
    await expect(createCoupon(db, owner, event.id, percent("OUTRO", 1000, { ticketTypeIds: [other.ticketTypes[0].id] }))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createCoupon(db, owner, event.id, { code: "SEMVALOR", discountType: "PERCENT" })).rejects.toThrow();
    await expect(createCoupon(db, owner, event.id, percent("x", 1000))).rejects.toThrow();
    await expect(createCoupon(db, owner, event.id, percent("DATAS", 1000, { validFromLocal: "2030-01-02T10:00", validUntilLocal: "2030-01-01T10:00" }))).rejects.toThrow();
    expect(await db.coupon.count()).toBe(0);
  });

  it("avisa quando o desconto deixa o ingresso abaixo da taxa da plataforma ou mais barato que a meia", async () => {
    const { owner, event } = await setup();
    // Taxa: 7% + R$ 1,00 por ingresso, descontada do organizador.
    await db.commissionRule.updateMany({ where: { scope: "PLATFORM" }, data: { fixedCentsPerTicket: 100, bearer: "ORGANIZER" } });
    // 95%: VIP (R$ 10) cai para R$ 0,50 < taxa; Inteira (R$ 50) cai para R$ 2,50 < meia (R$ 25).
    const { warnings } = await createCoupon(db, owner, event.id, percent("QUASE", 9500));
    // VIP já custa menos que a meia sem cupom: não recebe o aviso de meia.
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toMatch(/"VIP": .*abaixo da taxa/);
    expect(warnings.join("\n")).toMatch(/"Inteira": .*mais barato que a meia-entrada/);
    // 10%: nenhum aviso. Cupom de 100% zera o preço (gratuito), sem aviso de taxa.
    expect((await createCoupon(db, owner, event.id, percent("LEVE", 1000))).warnings).toEqual([]);
    // Cortesia de 100% (líquido 0) não recebe aviso de taxa nem de meia, como no checkout.
    const full = await createCoupon(db, owner, event.id, percent("CORTESIA", 10_000));
    expect(full.warnings).toEqual([]);
  });

  it("cupom usado: não apaga, código e desconto ficam fixos, limites e desativação continuam", async () => {
    const { owner, event } = await setup();
    const { coupon } = await createCoupon(db, owner, event.id, percent("USADO", 1000));
    const unused = (await createCoupon(db, owner, event.id, percent("NOVO", 1000))).coupon;
    // Simula um resgate (contadores são do passo 2).
    await db.coupon.update({ where: { id: coupon.id }, data: { timesRedeemed: 1 } });

    await expect(deleteCoupon(db, owner, coupon.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(updateCoupon(db, owner, coupon.id, percent("OUTRO", 1000))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(updateCoupon(db, owner, coupon.id, percent("USADO", 2000))).rejects.toMatchObject({ code: "VALIDATION" });
    const { coupon: limited } = await updateCoupon(db, owner, coupon.id, percent("USADO", 1000, { maxUses: 5, description: "parceria" }));
    expect(limited).toMatchObject({ maxUses: 5, description: "parceria", timesRedeemed: 1 });
    expect((await setCouponDisabled(db, owner, coupon.id, true)).disabledAt).not.toBeNull();
    expect((await setCouponDisabled(db, owner, coupon.id, false)).disabledAt).toBeNull();

    await deleteCoupon(db, owner, unused.id);
    expect(await db.coupon.findUnique({ where: { id: unused.id } })).toBeNull();
    const actions = (await db.auditLog.findMany({ where: { entityType: "Coupon" }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["coupon.created", "coupon.created", "coupon.updated", "coupon.disabled", "coupon.enabled", "coupon.deleted"]);
  });

  it("autorização: só quem tem event:write na organização do evento", async () => {
    const { owner, members, event } = await setup(["EVENT_MANAGER", "FINANCE", "CHECKIN_STAFF"]);
    const [manager, finance, staff] = members;
    const outsider = (await setup()).owner;
    const { coupon } = await createCoupon(db, manager, event.id, percent("GESTOR", 1000));

    for (const actor of [finance, staff, outsider]) {
      await expect(createCoupon(db, actor, event.id, percent("NEGADO", 1000))).rejects.toMatchObject(forbidden);
      await expect(listEventCoupons(db, actor, event.id)).rejects.toMatchObject(forbidden);
      await expect(updateCoupon(db, actor, coupon.id, percent("GESTOR", 1000, { maxUses: 1 }))).rejects.toMatchObject(forbidden);
      await expect(setCouponDisabled(db, actor, coupon.id, true)).rejects.toMatchObject(forbidden);
      await expect(deleteCoupon(db, actor, coupon.id)).rejects.toMatchObject(forbidden);
      await expect(createTrackingLink(db, actor, event.id, { name: "Negado" })).rejects.toMatchObject(forbidden);
      await expect(listEventTrackingLinks(db, actor, event.id)).rejects.toMatchObject(forbidden);
    }
    await expect(createCoupon(db, { ...owner, status: "SUSPENDED" }, event.id, percent("SUSPENSO", 1000))).rejects.toMatchObject(forbidden);
    expect(await db.coupon.count()).toBe(1);
  });

  it("evento cancelado não aceita cupom nem link novo", async () => {
    const { owner, event } = await setup();
    await db.event.update({ where: { id: event.id }, data: { status: "CANCELLED" } });
    await expect(createCoupon(db, owner, event.id, percent("TARDE", 1000))).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(createTrackingLink(db, owner, event.id, { name: "Tarde" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("T — links de divulgação", () => {
  it("cria link com código curto, cupom do mesmo evento e arquivamento auditado", async () => {
    const { owner, org, event } = await setup();
    const { coupon } = await createCoupon(db, owner, event.id, percent("INSTA", 1000));
    const link = await createTrackingLink(db, owner, event.id, { name: "Instagram stories", utmSource: "instagram", utmMedium: "social", couponId: coupon.id });
    expect(link.code).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(link).toMatchObject({ organizationId: org.id, eventId: event.id, utmSource: "instagram", utmMedium: "social", utmCampaign: null, couponId: coupon.id, clicks: 0 });

    // Cupom de outro evento ou desativado não pode ser pré-aplicado.
    const other = await makeEvent(org);
    const foreign = (await createCoupon(db, owner, other.id, percent("OUTROEV", 1000))).coupon;
    await expect(createTrackingLink(db, owner, event.id, { name: "Outro evento", couponId: foreign.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setCouponDisabled(db, owner, coupon.id, true);
    await expect(createTrackingLink(db, owner, event.id, { name: "Desativado", couponId: coupon.id })).rejects.toMatchObject({ code: "VALIDATION" });

    await setTrackingLinkArchived(db, owner, link.id, true);
    expect(await listEventTrackingLinks(db, owner, event.id)).toEqual([expect.objectContaining({ id: link.id, archived: true, couponCode: "INSTA", paidOrders: 0 })]);
    await setTrackingLinkArchived(db, owner, link.id, false);
    const actions = (await db.auditLog.findMany({ where: { entityId: link.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["tracking_link.created", "tracking_link.archived", "tracking_link.restored"]);
    // O verificador de tenant do passo 2 não acusa nada do que o cadastro deixou passar.
    expect((await checkFinancialInvariants(db)).find((v) => v.code === "COUPON_TENANT_MISMATCH")).toBeUndefined();
  });
});

describe("T — relatórios de origem e cupons", () => {
  it("contam só pedidos pagos, por link, utm_source ou direto, e por cupom", async () => {
    const { owner, members, org, event } = await setup(["FINANCE", "CHECKIN_STAFF"]);
    const [finance, staff] = members;
    const link = await createTrackingLink(db, owner, event.id, { name: "Instagram", utmSource: "instagram" });
    const { coupon } = await createCoupon(db, owner, event.id, percent("PROMO", 1000));
    const inteira = event.ticketTypes[0].id;

    const viaLink = (await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: inteira, quantity: 2 }])).order;
    const viaUtm = (await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: inteira, quantity: 1 }])).order;
    await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: inteira, quantity: 1 }]); // direto
    const pending = await buy(await makeUser(), event.id, [{ ticketTypeId: inteira, quantity: 3 }]); // não pago: fora dos relatórios
    await db.order.update({ where: { id: viaLink.id }, data: { trackingLinkId: link.id, utmSource: "instagram", couponId: coupon.id, couponCode: coupon.code, discountCents: 1000 } });
    await db.order.update({ where: { id: viaUtm.id }, data: { utmSource: "newsletter" } });
    await db.order.update({ where: { id: pending.id }, data: { trackingLinkId: link.id } });

    const sources = await salesBySource(db, finance, org.id);
    expect(sources.map((s) => [s.kind, s.label, s.orders, s.netTicketCents, s.discountCents])).toEqual([
      ["link", "Instagram", 1, 10000, 1000],
      ["utm", "newsletter", 1, 5000, 0],
      ["direct", "Direto / sem origem", 1, 5000, 0],
    ]);
    expect(await couponUsage(db, finance, org.id)).toEqual([
      expect.objectContaining({ code: "PROMO", eventTitle: event.title, paidOrders: 1, discountCents: 1000, netTicketCents: 10000 }),
    ]);
    expect(await listEventTrackingLinks(db, owner, event.id)).toEqual([expect.objectContaining({ id: link.id, paidOrders: 1 })]);

    expect((await checkFinancialInvariants(db)).find((v) => v.code === "COUPON_TENANT_MISMATCH")).toBeUndefined();

    // Relatórios exigem finance:read na organização.
    await expect(salesBySource(db, staff, org.id)).rejects.toMatchObject(forbidden);
    await expect(couponUsage(db, staff, org.id)).rejects.toMatchObject(forbidden);
    const outsider = (await setup()).owner;
    await expect(salesBySource(db, outsider, org.id)).rejects.toMatchObject(forbidden);
  });
});
