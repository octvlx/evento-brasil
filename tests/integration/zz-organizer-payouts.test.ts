// Repasses do provedor ao organizador: gravados na sincronização do pagamento e resumidos
// para a tela "Vendas e repasses" (só acompanhamento; nada é transferido pela plataforma).
import { beforeEach, describe, expect, it } from "vitest";
import type { PaymentProviderAdapter } from "@/server/payments/types";
import { syncPaymentFromProvider } from "@/server/services/payments";
import { organizerPayouts } from "@/server/services/reports";
import { adapter, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup() {
  const owner = await makeUser();
  const staff = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: staff.id, role: "CHECKIN_STAFF" }] });
  const event = await makeEvent(org, { tickets: [{ priceCents: 10_000, quantityTotal: 50 }] });
  const buy = async () => {
    const { order, payment } = await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    return { order, payment: await db.payment.findUniqueOrThrow({ where: { id: payment.id } }) };
  };
  return { owner, staff, org, buy };
}

describe("repasses do provedor", () => {
  it("a sincronização grava a liberação informada pelo provedor (e não regrava sem mudança)", async () => {
    const { buy } = await setup();
    const { payment } = await buy();
    const releaseAt = new Date("2030-01-10T15:00:00.000Z");
    // Mesmo provedor simulado, com o repasse que o Mercado Pago informaria.
    const withRelease = Object.assign(Object.create(adapter), {
      getPayment: async (id: string) => ({ ...(await adapter.getPayment(id)), release: { at: releaseAt, status: "pending", netCents: 8_900 } }),
    }) as PaymentProviderAdapter;
    await syncPaymentFromProvider(db, withRelease, payment.providerPaymentId!);
    const after = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after).toMatchObject({ providerReleaseAt: releaseAt, providerReleaseStatus: "pending", providerNetCents: 8_900, status: "PAID" });
    await syncPaymentFromProvider(db, withRelease, payment.providerPaymentId!);
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).updatedAt).toEqual(after.updatedAt);
  });

  it("resume liberado, a liberar (com a próxima data) e estornado; sem dado do provedor, líquido estimado", async () => {
    const { owner, org, buy } = await setup();
    const now = new Date("2030-01-05T12:00:00.000Z");
    const a = await buy();
    const b = await buy();
    const c = await buy();
    const d = await buy();
    await db.payment.update({ where: { id: a.payment.id }, data: { providerReleaseAt: new Date("2030-01-01T00:00:00Z"), providerReleaseStatus: "released", providerNetCents: 9_000 } });
    await db.payment.update({ where: { id: b.payment.id }, data: { providerReleaseAt: new Date("2030-01-20T00:00:00Z"), providerReleaseStatus: "pending", providerNetCents: 8_800 } });
    await db.payment.update({ where: { id: c.payment.id }, data: { providerReleaseAt: new Date("2030-01-12T00:00:00Z"), providerReleaseStatus: "pending", providerNetCents: 8_700 } });
    await db.payment.update({ where: { id: d.payment.id }, data: { status: "REFUNDED" } });

    const r = await organizerPayouts(db, owner, org.id, 1, now);
    expect(r).toMatchObject({ total: 4, releasedCents: 9_000, pendingCents: 17_500, nextReleaseAt: new Date("2030-01-12T00:00:00Z") });
    const byId = new Map(r.items.map((i) => [i.id, i]));
    expect(byId.get(a.payment.id)).toMatchObject({ state: "RELEASED", netCents: 9_000, netFromProvider: true });
    expect(byId.get(c.payment.id)).toMatchObject({ state: "PENDING", netCents: 8_700 });
    expect(byId.get(d.payment.id)).toMatchObject({ state: "REFUNDED", netCents: 0 });

    // Sem informação do provedor: situação desconhecida e líquido estimado pelo pedido.
    const e = await buy();
    const order = await db.order.findUniqueOrThrow({ where: { id: e.order.id } });
    const item = (await organizerPayouts(db, owner, org.id, 1, now)).items.find((i) => i.id === e.payment.id)!;
    expect(item).toMatchObject({ state: "UNKNOWN", netFromProvider: false, netCents: order.totalCents - order.commissionCents - (e.payment.processingFeeCents ?? 0) });
  });

  it("só quem vê o financeiro da organização", async () => {
    const { staff, org } = await setup();
    await expect(organizerPayouts(db, staff, org.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
