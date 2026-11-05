// Decreto 13.108, R1 (tarefa L1a): o preço total por ingresso exibido no
// catálogo (preço + taxa de serviço) é exatamente o que o createOrder cobra e
// o que vai ao provedor de pagamento.
import { beforeEach, describe, expect, it } from "vitest";
import { commissionPerUnit } from "@/features/fees/policy";
import { buyerPricePreview, currentPlatformCommissionRule, resolveCommissionRule, setCommissionRule, type NewRuleInput } from "@/server/services/commission";
import { startPayment } from "@/server/services/payments";
import { createOrder } from "@/server/services/orders";
import { adapter, db, makeEvent, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);

type Rule = Pick<NewRuleInput, "scope" | "organizationId" | "eventId" | "percentBps" | "fixedCentsPerTicket" | "bearer">;

async function setRule(rule: Rule) {
  const admin = await makeUser({ admin: true });
  return setCommissionRule(db, admin, { processingFeeBearer: "ORGANIZER", refundCommissionOnRefund: true, ...rule });
}

/** Prévia como a página do evento calcula: regra do evento + preço de cada tipo. */
async function previewFor(event: { id: string; organizationId: string; ticketTypes: { id: string; priceCents: number; kind: string }[] }) {
  const rule = await resolveCommissionRule(db, event.organizationId, event.id);
  return new Map(
    event.ticketTypes.map((t) => {
      const half = t.kind === "HALF_PRICE";
      const p = buyerPricePreview(rule, t.priceCents, half);
      // Mesma conta feita direto com commissionPerUnit (fórmula usada nas páginas públicas).
      const direct = rule.bearer === "BUYER" ? commissionPerUnit(t.priceCents, rule, half) : 0;
      expect(p.serviceFeeCents).toBe(direct);
      return [t.id, p];
    }),
  );
}

/** Compra todos os tipos (quantidades 1, 2, 3…) e confere item a item com a prévia. */
async function expectChargedEqualsPreview(event: Parameters<typeof previewFor>[0]) {
  const preview = await previewFor(event);
  const customer = await makeUser();
  const items = event.ticketTypes.map((t, i) => ({ ticketTypeId: t.id, quantity: i + 1 }));
  // Declaração da meia sempre marcada: alguns cenários incluem HALF_PRICE.
  const order = await createOrder(db, customer, orderInput(event.id, items, { halfPriceDeclaration: true }), { providerIsSimulated: true });
  const saved = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
  for (const item of saved.items) {
    const p = preview.get(item.ticketTypeId)!;
    expect(item.unitPriceCents).toBe(p.priceCents);
    expect(item.serviceFeePerUnitCents).toBe(p.serviceFeeCents);
  }
  const expectedTotal = items.reduce((s, i) => s + preview.get(i.ticketTypeId)!.totalCents * i.quantity, 0);
  const expectedFee = items.reduce((s, i) => s + preview.get(i.ticketTypeId)!.serviceFeeCents * i.quantity, 0);
  expect(saved.totalCents).toBe(expectedTotal);
  expect(saved.serviceFeeCents).toBe(expectedFee);
  if (saved.totalCents > 0) {
    const payment = await startPayment(db, adapter, customer, order.id, "PIX");
    expect(payment.amountCents).toBe(expectedTotal);
    const sent = await db.simulatedProviderPayment.findUniqueOrThrow({ where: { id: payment.providerPaymentId! } });
    expect(sent.amountCents).toBe(expectedTotal);
  }
  return { preview, order: saved };
}

const TICKETS = [
  { priceCents: 10000, quantityTotal: 50 },
  { priceCents: 3333, quantityTotal: 50 }, // arredondamento do percentual
  { priceCents: 0, quantityTotal: 50 }, // gratuito: nunca tem taxa
];

async function setup(tickets = TICKETS) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, { tickets });
  return { org, event };
}

describe("R — prévia de preço ao comprador = valor cobrado", () => {
  it("bearer BUYER com percentual + taxa fixa: total por ingresso inclui a taxa", async () => {
    await setRule({ scope: "PLATFORM", percentBps: 1000, fixedCentsPerTicket: 150, bearer: "BUYER" });
    const { event } = await setup();
    const { preview } = await expectChargedEqualsPreview(event);
    expect(preview.get(event.ticketTypes[0].id)).toEqual({ priceCents: 10000, serviceFeeCents: 1150, totalCents: 11150 });
    expect(preview.get(event.ticketTypes[1].id)).toEqual({ priceCents: 3333, serviceFeeCents: 483, totalCents: 3816 });
    expect(preview.get(event.ticketTypes[2].id)).toEqual({ priceCents: 0, serviceFeeCents: 0, totalCents: 0 });
  });

  it("bearer ORGANIZER: comprador paga o valor de face, sem taxa", async () => {
    await setRule({ scope: "PLATFORM", percentBps: 1000, fixedCentsPerTicket: 150, bearer: "ORGANIZER" });
    const { event } = await setup();
    const { preview, order } = await expectChargedEqualsPreview(event);
    for (const t of event.ticketTypes) expect(preview.get(t.id)).toEqual({ priceCents: t.priceCents, serviceFeeCents: 0, totalCents: t.priceCents });
    expect(order.commissionCents).toBeGreaterThan(0); // a comissão existe, mas sai do repasse
  });

  it("só ingressos gratuitos: prévia e pedido zerados", async () => {
    await setRule({ scope: "PLATFORM", percentBps: 1000, fixedCentsPerTicket: 150, bearer: "BUYER" });
    const { event } = await setup([{ priceCents: 0, quantityTotal: 10 }]);
    const { order } = await expectChargedEqualsPreview(event);
    expect(order).toMatchObject({ status: "PAID", totalCents: 0, serviceFeeCents: 0 });
  });

  it("regra da organização sobrepõe a da plataforma, só para os eventos dela", async () => {
    // Plataforma: 7% do organizador (padrão do resetDb).
    const a = await setup();
    const b = await setup();
    await setRule({ scope: "ORGANIZATION", organizationId: a.org.id, percentBps: 500, fixedCentsPerTicket: 200, bearer: "BUYER" });
    const pa = await expectChargedEqualsPreview(a.event);
    const pb = await expectChargedEqualsPreview(b.event);
    expect(pa.preview.get(a.event.ticketTypes[0].id)).toEqual({ priceCents: 10000, serviceFeeCents: 700, totalCents: 10700 });
    expect(pb.preview.get(b.event.ticketTypes[0].id)).toEqual({ priceCents: 10000, serviceFeeCents: 0, totalCents: 10000 });
  });

  it("regra do evento sobrepõe a da organização", async () => {
    const { org, event } = await setup();
    const other = await makeEvent(org, { tickets: TICKETS });
    await setRule({ scope: "ORGANIZATION", organizationId: org.id, percentBps: 500, fixedCentsPerTicket: 0, bearer: "BUYER" });
    await setRule({ scope: "EVENT", eventId: event.id, percentBps: 1200, fixedCentsPerTicket: 99, bearer: "BUYER" });
    const pe = await expectChargedEqualsPreview(event);
    const po = await expectChargedEqualsPreview(other);
    expect(pe.preview.get(event.ticketTypes[0].id)).toEqual({ priceCents: 10000, serviceFeeCents: 1299, totalCents: 11299 });
    expect(po.preview.get(other.ticketTypes[0].id)).toEqual({ priceCents: 10000, serviceFeeCents: 500, totalCents: 10500 });
  });

  // D4: a taxa da meia-entrada é proporcional ao valor da meia (parte fixa pela metade).
  const HALF = [
    { priceCents: 10000, quantityTotal: 50 },
    { priceCents: 5000, quantityTotal: 50, kind: "HALF_PRICE" as const },
  ];

  it("meia-entrada com taxa do comprador: parte fixa pela metade, prévia = cobrado", async () => {
    await setRule({ scope: "PLATFORM", percentBps: 1000, fixedCentsPerTicket: 150, bearer: "BUYER" });
    const { event } = await setup(HALF);
    const { preview, order } = await expectChargedEqualsPreview(event);
    expect(preview.get(event.ticketTypes[0].id)).toEqual({ priceCents: 10000, serviceFeeCents: 1150, totalCents: 11150 });
    // 10% de 50,00 + 0,75 (metade de 1,50) = 5,75: exatamente metade da taxa da inteira, arredondada.
    expect(preview.get(event.ticketTypes[1].id)).toEqual({ priceCents: 5000, serviceFeeCents: 575, totalCents: 5575 });
    const half = order.items.find((i) => i.ticketTypeId === event.ticketTypes[1].id)!;
    expect(half.commissionPerUnitCents).toBe(575);
  });

  it("meia-entrada com taxa do organizador: comissão proporcional sai do repasse", async () => {
    await setRule({ scope: "PLATFORM", percentBps: 700, fixedCentsPerTicket: 99, bearer: "ORGANIZER" });
    const { event } = await setup(HALF);
    const { order } = await expectChargedEqualsPreview(event);
    const byType = new Map(order.items.map((i) => [i.ticketTypeId, i]));
    expect(byType.get(event.ticketTypes[0].id)!.commissionPerUnitCents).toBe(799);
    // 7% de 50,00 + 0,50 (metade de 0,99, arredondada para cima).
    expect(byType.get(event.ticketTypes[1].id)!.commissionPerUnitCents).toBe(400);
    expect(order.commissionCents).toBe(799 * 1 + 400 * 2);
  });
});

describe("Página \"Publique seu evento\": regra de plataforma vigente", () => {
  it("mostra a regra de plataforma em vigor, ignora regras de organização e acompanha a troca feita pelo admin", async () => {
    expect(await currentPlatformCommissionRule(db)).toMatchObject({ scope: "PLATFORM", percentBps: 700 });
    const org = await makeOrg(await makeUser());
    await setRule({ scope: "ORGANIZATION", organizationId: org.id, percentBps: 300, fixedCentsPerTicket: 0, bearer: "ORGANIZER" });
    expect(await currentPlatformCommissionRule(db)).toMatchObject({ scope: "PLATFORM", percentBps: 700 });
    await setRule({ scope: "PLATFORM", percentBps: 1000, fixedCentsPerTicket: 150, bearer: "BUYER" });
    const current = await currentPlatformCommissionRule(db);
    expect(current).toMatchObject({ scope: "PLATFORM", percentBps: 1000, fixedCentsPerTicket: 150, bearer: "BUYER" });
    // Exemplo da página (R$ 100,00) = mesma conta do checkout.
    expect(commissionPerUnit(10_000, current!)).toBe(1_150);
    expect(buyerPricePreview(current!, 10_000).totalCents).toBe(11_150);
  });
});
