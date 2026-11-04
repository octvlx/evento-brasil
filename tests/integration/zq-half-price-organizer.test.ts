// L7c — parte do organizador: controle de meia-entrada (painel), guardas de mudança de
// estoque/capacidade/tipos, auditoria `half_price.stock_changed`, isolamento entre
// organizações e coerência do CSV L7b com o controle. Postgres real.
import { beforeEach, describe, expect, it } from "vitest";
import { formatReleaseAt } from "@/features/half-price/quota";
import { deleteTicketType, updateEvent, upsertTicketType } from "@/server/services/events";
import { halfPriceControl, halfPriceReport, halfPriceReportToCsv, organizerHalfPriceSummary } from "@/server/services/reports";
import { createOrder } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { adapter, db, makeEvent, makeOrg, makeUser, orderInput, resetDb, type TicketSpec } from "../support/fixtures";

beforeEach(resetDb);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FULL = (quantityTotal: number, extra: Partial<TicketSpec> = {}): TicketSpec => ({ priceCents: 10000, quantityTotal, ...extra });
const HALF = (quantityTotal: number, extra: Partial<TicketSpec> = {}): TicketSpec => ({ priceCents: 5000, quantityTotal, kind: "HALF_PRICE", ...extra });

/** Instante alinhado ao minuto: sobrevive à ida e volta por `datetime-local`. */
const minute = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000);
/** "AAAA-MM-DDTHH:mm" em São Paulo (UTC−3, sem horário de verão). */
const local = (d: Date) => new Date(d.getTime() - 3 * HOUR).toISOString().slice(0, 16);

async function setup(opts: Parameters<typeof makeEvent>[1] = {}) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org, {
    capacity: 100,
    halfPriceQuotaBps: 4000,
    venueCapacity: 1000,
    startsAt: minute(Date.now() + 10 * DAY),
    tickets: [FULL(100), HALF(50)],
    ...opts,
  });
  return { owner, org, event, full: event.ticketTypes[0], half: event.ticketTypes[1] };
}

type EventRow = Awaited<ReturnType<typeof makeEvent>>;

/** Entrada do formulário igual ao evento atual (a partir da linha), com ajustes. */
function editInput(event: EventRow, patch: Record<string, unknown> = {}) {
  return {
    title: event.title,
    description: event.description,
    categoryId: event.categoryId,
    locationType: "VENUE" as const,
    venueId: event.venueId ?? undefined,
    timezone: "America/Sao_Paulo" as const,
    startsAtLocal: local(event.startsAt),
    endsAtLocal: local(event.endsAt),
    salesStartLocal: local(new Date(Date.now() - DAY)),
    salesEndLocal: local(event.startsAt),
    ageRestriction: 0,
    capacity: event.capacity,
    halfPriceQuotaPercent: event.halfPriceQuotaBps === null ? undefined : event.halfPriceQuotaBps / 100,
    refundPolicy: event.refundPolicy,
    ...patch,
  };
}

type TicketRow = EventRow["ticketTypes"][number];
const typeInput = (t: TicketRow, patch: Record<string, unknown> = {}) => ({
  id: t.id,
  name: t.name,
  kind: t.kind,
  priceCents: t.priceCents,
  quantityTotal: t.quantityTotal,
  minPerOrder: t.minPerOrder,
  maxPerOrder: t.maxPerOrder,
  isHidden: t.isHidden,
  ...patch,
});

/** Pedido com declaração de meia, pago por PIX simulado (webhook assinado). */
async function buyAndPay(user: Awaited<ReturnType<typeof makeUser>>, eventId: string, items: { ticketTypeId: string; quantity: number }[]) {
  const order = await createOrder(db, user, orderInput(eventId, items, { halfPriceDeclaration: true }), { providerIsSimulated: true });
  const payment = await startPayment(db, adapter, user, order.id, "PIX");
  await handlePaymentWebhook(db, adapter, await adapter.simulate(payment.providerPaymentId!, "approve"));
  return { order };
}

const setCounts = (id: string, data: { quantitySold?: number; quantityReserved?: number }) => db.ticketType.update({ where: { id }, data });
const audits = (action: string) => db.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });
const meta = (a: { metadata: unknown }) => a.metadata as { source: string; before: Record<string, number | string | null>; after: Record<string, number | string | null> };

describe("controle de meia-entrada (painel do organizador)", () => {
  it("RESERVED: números do backend, prazo de 48 h e data/hora no fuso do evento", async () => {
    const { owner, event, full } = await setup();
    await setCounts(full.id, { quantitySold: 10 });
    const c = await halfPriceControl(db, owner, event.id);
    expect(c).toMatchObject({
      status: "RESERVED",
      applicable: true,
      reserveActive: true,
      notApplicableReason: null,
      eligibleStock: 100,
      quota: 40,
      halfLimit: 40,
      halfSold: 0,
      halfReserved: 0,
      balance: 40,
      unavailableForFull: 40,
      deadlineHours: 48,
      physicalCapacity: 1000,
      eventCapacity: 100,
      onSaleStock: 150,
      halfStock: 50,
      configuredLimitPercent: 40,
      regime: "FEDERAL",
      warnings: [],
    });
    expect(c.releaseAt.getTime()).toBe(event.startsAt.getTime() - 48 * HOUR);
    expect(c.releaseAtLabel).toBe(formatReleaseAt(c.releaseAt, "America/Sao_Paulo"));
    expect(c.releaseAtLabel).toMatch(/^\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}$/);
  });

  it("EXHAUSTED: meias vendidas e reservadas atingem a cota", async () => {
    const { owner, event, half } = await setup();
    await setCounts(half.id, { quantitySold: 30, quantityReserved: 10 });
    const c = await halfPriceControl(db, owner, event.id);
    expect(c).toMatchObject({ status: "EXHAUSTED", halfSold: 30, halfReserved: 10, balance: 0, unavailableForFull: 0 });
  });

  it("RELEASED: depois de releaseAt a reserva termina (cálculo pelo relógio)", async () => {
    const { owner, event } = await setup();
    const releaseAt = event.startsAt.getTime() - 48 * HOUR;
    expect(await halfPriceControl(db, owner, event.id, new Date(releaseAt - 1))).toMatchObject({ status: "RESERVED", reserveActive: true });
    expect(await halfPriceControl(db, owner, event.id, new Date(releaseAt))).toMatchObject({ status: "RELEASED", reserveActive: false, unavailableForFull: 0, balance: 40 });
  });

  it("NOT_APPLICABLE: regime não sujeito e evento sem tipo de meia", async () => {
    const a = await setup({ halfPriceRegime: "NOT_SUBJECT" });
    await db.event.update({ where: { id: a.event.id }, data: { halfPriceRegimeNote: "Evento privado" } });
    expect(await halfPriceControl(db, a.owner, a.event.id)).toMatchObject({
      status: "NOT_APPLICABLE",
      notApplicableReason: "NOT_SUBJECT",
      regime: "NOT_SUBJECT",
      regimeNote: "Evento privado",
      balance: 0,
      unavailableForFull: 0,
    });
    const b = await setup({ tickets: [FULL(100)] });
    expect(await halfPriceControl(db, b.owner, b.event.id)).toMatchObject({ status: "NOT_APPLICABLE", notApplicableReason: "NO_HALF_PRICE_TYPE" });
  });

  it("48 h até 10.000 lugares no local e 72 h acima", async () => {
    for (const [venueCapacity, hours] of [[10_000, 48], [15_000, 72]] as const) {
      const { owner, event } = await setup({ venueCapacity });
      const c = await halfPriceControl(db, owner, event.id);
      expect(c.deadlineHours).toBe(hours);
      expect(c.releaseAt.getTime()).toBe(event.startsAt.getTime() - hours * HOUR);
    }
  });

  it("avisos: estoque de meia menor que a cota e limite configurado abaixo de 40%", async () => {
    const low = await setup({ tickets: [FULL(100), HALF(10)] });
    expect((await halfPriceControl(db, low.owner, low.event.id)).warnings).toEqual(["HALF_STOCK_BELOW_QUOTA"]);
    const bps = await setup({ halfPriceQuotaBps: 3000 });
    const c = await halfPriceControl(db, bps.owner, bps.event.id);
    expect(c.warnings).toEqual(["CONFIGURED_BPS_BELOW_LEGAL"]);
    expect(c).toMatchObject({ configuredLimitPercent: 30, quota: 40, halfLimit: 40 });
  });

  it("limite maior que 40% e sem limite", async () => {
    const more = await setup({ halfPriceQuotaBps: 5000 });
    expect(await halfPriceControl(db, more.owner, more.event.id)).toMatchObject({ quota: 40, halfLimit: 50 });
    const none = await setup({ tickets: [FULL(100), HALF(50)] });
    await db.event.update({ where: { id: none.event.id }, data: { halfPriceQuotaBps: null } });
    expect(await halfPriceControl(db, none.owner, none.event.id)).toMatchObject({ halfLimit: null, configuredLimitPercent: null });
  });
});

describe("isolamento e permissão", () => {
  it("outra organização, cliente comum e papéis sem finance:read não leem o controle", async () => {
    const { owner, org, event } = await setup();
    const finance = await makeUser();
    const manager = await makeUser();
    const staff = await makeUser();
    await db.organizationMember.createMany({
      data: [
        { organizationId: org.id, userId: finance.id, role: "FINANCE" },
        { organizationId: org.id, userId: manager.id, role: "EVENT_MANAGER" },
        { organizationId: org.id, userId: staff.id, role: "CHECKIN_STAFF" },
      ],
    });
    expect(await halfPriceControl(db, finance, event.id)).toMatchObject({ quota: 40 });
    const otherOwner = await makeUser();
    const otherOrg = await makeOrg(otherOwner);
    for (const actor of [otherOwner, await makeUser(), manager, staff]) {
      await expect(halfPriceControl(db, actor, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(halfPriceControl(db, owner, "evento-inexistente")).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Resumo por organização: escopo da organização consultada.
    await expect(organizerHalfPriceSummary(db, otherOwner, org.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await organizerHalfPriceSummary(db, otherOwner, otherOrg.id)).toEqual([]);
    expect(await organizerHalfPriceSummary(db, owner, org.id)).toEqual([expect.objectContaining({ id: event.id, quota: 40, balance: 40, status: "RESERVED" })]);
  });
});

describe("mudança de capacidade com vendas (cenário 18)", () => {
  it("recusa a redução que invade a cota legal e aceita o aumento; audita antes/depois", async () => {
    const { owner, event, full } = await setup();
    await setCounts(full.id, { quantitySold: 60 });
    // 60 inteiras + cota de 40 = 100: com capacidade 80 faltariam ingressos para a cota.
    await expect(updateEvent(db, owner, event.id, editInput(event, { capacity: 80 }))).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("reserva legal de meia-entrada"),
    });
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).capacity).toBe(100);
    expect(await audits("half_price.stock_changed")).toHaveLength(0);

    await updateEvent(db, owner, event.id, editInput(event, { capacity: 120 }));
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).capacity).toBe(120);
    const [entry] = await audits("half_price.stock_changed");
    expect(entry).toMatchObject({ entityType: "Event", entityId: event.id, actorUserId: owner.id });
    expect(meta(entry)).toMatchObject({
      source: "event.updated",
      before: { eventCapacity: 100, eligibleStock: 100, quota: 40, fullSold: 60 },
      after: { eventCapacity: 120, eligibleStock: 120, quota: 48, fullSold: 60 },
    });
  });

  it("alteração sem mudar capacidade, data, local nem limite não gera auditoria de estoque", async () => {
    const { owner, event } = await setup();
    await updateEvent(db, owner, event.id, editInput(event, { title: "Outro título" }));
    expect(await audits("half_price.stock_changed")).toHaveLength(0);
  });
});

describe("mudança de tipos de ingresso", () => {
  it("quantityTotal: redução que invade a cota é recusada; redução segura é aceita e auditada", async () => {
    const { owner, event, full, half } = await setup({ capacity: 150, tickets: [FULL(70), HALF(50)] });
    await setCounts(full.id, { quantitySold: 60 });
    // Meia de 50 para 1: o estoque elegível cai para 71 e a cota (28) não cabe ao lado das 60 inteiras.
    await expect(upsertTicketType(db, owner, event.id, typeInput(half, { quantityTotal: 1 }))).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("reserva legal de meia-entrada"),
    });
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: half.id } })).quantityTotal).toBe(50);
    // Inteira de 70 para 60 (= vendidas): segue cabendo.
    await upsertTicketType(db, owner, event.id, typeInput(full, { quantityTotal: 60 }));
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: full.id } })).quantityTotal).toBe(60);
    const [entry, ...rest] = await audits("half_price.stock_changed");
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({ entityType: "TicketType", entityId: full.id });
    expect(meta(entry)).toMatchObject({ source: "ticket_type.updated", before: { eligibleStock: 120 }, after: { eligibleStock: 110 } });
  });

  it("novo tipo de ingresso que muda o estoque elegível é auditado", async () => {
    const { owner, event, full } = await setup({ capacity: 150, tickets: [FULL(70), HALF(10)] });
    await setCounts(full.id, { quantitySold: 60 });
    const created = await upsertTicketType(db, owner, event.id, { name: "Lote extra", kind: "GENERAL", priceCents: 12000, quantityTotal: 20 });
    const entries = await audits("half_price.stock_changed");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityId: created.id });
    expect(meta(entries[0])).toMatchObject({ source: "ticket_type.created", before: { eligibleStock: 80 }, after: { eligibleStock: 100 } });
  });

  it("alterar só o nome do tipo não gera auditoria de estoque", async () => {
    const { owner, event, full } = await setup();
    await upsertTicketType(db, owner, event.id, typeInput(full, { name: "Pista" }));
    expect(await audits("half_price.stock_changed")).toHaveLength(0);
  });

  it("exclusão de tipo: recusada se invade a cota; aceita e auditada se cabe", async () => {
    const { owner, event, full } = await setup({ capacity: 150, tickets: [FULL(70), FULL(30), HALF(10)] });
    const [, extra, half] = event.ticketTypes;
    await setCounts(full.id, { quantitySold: 60 });
    // Sem o lote de 30, E cai de 110 para 80 e as 60 inteiras mais a cota (32) passam disso.
    await expect(deleteTicketType(db, owner, extra.id)).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("reserva legal de meia-entrada") });
    expect(await db.ticketType.count({ where: { id: extra.id } })).toBe(1);
    // Sem o tipo de meia a reserva deixa de se aplicar: pode excluir.
    await deleteTicketType(db, owner, half.id);
    expect(await db.ticketType.count({ where: { id: half.id } })).toBe(0);
    const [entry] = await audits("half_price.stock_changed");
    expect(entry).toMatchObject({ entityId: half.id });
    expect(meta(entry)).toMatchObject({ source: "ticket_type.deleted", before: { status: "RESERVED" }, after: { status: "NOT_APPLICABLE", applicable: false } });
    expect(await audits("ticket_type.deleted")).toHaveLength(1);
  });

  it("outra organização não altera nem exclui tipos", async () => {
    const { event, full } = await setup();
    const other = await makeUser();
    await makeOrg(other);
    await expect(upsertTicketType(db, other, event.id, typeInput(full, { quantityTotal: 5 }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(deleteTicketType(db, other, full.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("mudança de data com vendas (cenário 19)", () => {
  it("é permitida mesmo quando a reserva volta a valer e a inteira fica barrada; fica auditada", async () => {
    // Começa em 24 h: reserva já liberada (prazo de 48 h passou) e 90 inteiras vendidas.
    const { owner, event, full } = await setup({ startsAt: minute(Date.now() + 24 * HOUR), tickets: [FULL(100), HALF(50)] });
    await setCounts(full.id, { quantitySold: 90 });
    expect(await halfPriceControl(db, owner, event.id)).toMatchObject({ status: "RELEASED", unavailableForFull: 0 });

    const newStart = minute(Date.now() + 10 * DAY);
    await updateEvent(
      db,
      owner,
      event.id,
      editInput(event, {
        startsAtLocal: local(newStart),
        endsAtLocal: local(new Date(newStart.getTime() + 4 * HOUR)),
        salesEndLocal: local(newStart),
      }),
    );
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).startsAt.getTime()).toBe(newStart.getTime());
    // Reserva ativa de novo; as 90 inteiras já passam do que cabe ao lado da cota.
    const c = await halfPriceControl(db, owner, event.id);
    expect(c).toMatchObject({ status: "RESERVED", reserveActive: true, fullAvailable: 0 });
    const [entry] = await audits("half_price.stock_changed");
    expect(meta(entry)).toMatchObject({
      source: "event.updated",
      before: { status: "RELEASED", reserveActive: false, violation: 0 },
      after: { status: "RESERVED", reserveActive: true, violation: 30 },
    });
    expect(meta(entry).before.releaseAt).not.toBe(meta(entry).after.releaseAt);
  });
});

describe("CSV da meia-entrada (L7b) coerente com o controle", () => {
  it("cota, saldo, estoque elegível, situação e prazo iguais nos dois", async () => {
    const { owner, event, full, half } = await setup();
    await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: half.id, quantity: 3 }, { ticketTypeId: full.id, quantity: 2 }]);
    const buyer = await makeUser();
    const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: half.id, quantity: 1 }]);
    expect(order.id).toBeTruthy();

    const control = await halfPriceControl(db, owner, event.id);
    const report = await halfPriceReport(db, owner, event.id);
    expect(report).toMatchObject({
      quota: control.quota,
      remaining: control.balance,
      sold: control.halfSold,
      reserved: control.halfReserved,
      eligibleStock: control.eligibleStock,
      halfLimit: control.halfLimit,
      reserveStatus: control.status,
      deadlineHours: control.deadlineHours,
    });
    expect(report.releaseAt.getTime()).toBe(control.releaseAt.getTime());
    expect(control).toMatchObject({ halfSold: 4, balance: 36, quota: 40 });

    const lines = halfPriceReportToCsv(report).slice(1).split("\r\n");
    expect(lines).toContain('"Cota de meia-entrada (ingressos)";"40"');
    expect(lines).toContain('"Cota restante";"36"');
    expect(lines).toContain('"Estoque elegível (base da cota)";"100"');
    expect(lines).toContain('"Limite de meia-entrada (ingressos)";"40"');
    expect(lines).toContain('"Situação da reserva";"Reservada"');
    expect(lines).toContain('"Prazo da reserva (horas antes do início)";"48"');
    expect(lines).toContain(`"Liberação da reserva";"${control.releaseAtLabel}"`);
    // As colunas existentes continuam na mesma ordem; o bloco por dia segue por último.
    expect(lines.findIndex((l) => l.startsWith('"Gerado em"'))).toBeLessThan(lines.indexOf('"Situação da reserva";"Reservada"'));
    expect(lines.at(-1)).toMatch(/^"\d{2}\/\d{2}\/\d{4}";"4";"200,00";"6"$/);
  });

  it("evento em regime não sujeito: cota e saldo ficam como não se aplica no CSV", async () => {
    const { owner, event } = await setup({ halfPriceRegime: "NOT_SUBJECT" });
    const report = await halfPriceReport(db, owner, event.id);
    expect(report).toMatchObject({ quota: null, remaining: null, reserveStatus: "NOT_APPLICABLE" });
    const lines = halfPriceReportToCsv(report).slice(1).split("\r\n");
    expect(lines).toContain('"Cota restante";"Não se aplica"');
    expect(lines).toContain('"Situação da reserva";"Não se aplica"');
  });
});
