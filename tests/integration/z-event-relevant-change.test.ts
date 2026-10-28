// Alteração relevante de evento com vendas (R8, L8b) e limite de ingressos por conta (R4, L4b).
// Padrões provisórios (D2) em src/features/organizer/event-change-rules.ts.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage } from "@/server/email";
import { CHANGE_REASON_REQUIRED, REFUND_WINDOW_DAYS_AFTER_CHANGE } from "@/features/organizer/event-change-rules";
import { createEvent, updateEvent } from "@/server/services/events";
import { extendEventChangeWindow, listEventChanges } from "@/server/services/event-changes";
import { notifyEventChange } from "@/server/services/notifications";
import { createOrder } from "@/server/services/orders";
import { handlePaymentWebhook, startPayment } from "@/server/services/payments";
import { adapter, buyAndPay, db, makeCategory, makeCity, makeOrg, makeUser, orderInput, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const DAY = 86_400_000;

/** "AAAA-MM-DDTHH:mm" no fuso de São Paulo (UTC−3, sem horário de verão). */
function localInput(d: Date) {
  return new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 16);
}

function when(startsInDays: number) {
  const startsAt = new Date(Date.now() + startsInDays * DAY);
  return { startsAtLocal: localInput(startsAt), endsAtLocal: localInput(new Date(startsAt.getTime() + 4 * 3_600_000)) };
}

async function eventInput(extra: Record<string, unknown> = {}) {
  const [city, category] = await Promise.all([makeCity(), makeCategory()]);
  return {
    title: "Show com alteração",
    description: "Descrição de teste com mais de vinte caracteres.",
    categoryId: category.id,
    locationType: "VENUE" as const,
    newVenue: { name: "Casa de Shows", addressLine: "Rua A, 10", district: "Centro", cityId: city.id, postalCode: "01001-000" },
    timezone: "America/Sao_Paulo" as const,
    ...when(10),
    salesStartLocal: localInput(new Date(Date.now() - DAY)),
    salesEndLocal: localInput(new Date(Date.now() + 9 * DAY)),
    ageRestriction: 0,
    capacity: 100,
    refundPolicy: "Reembolso conforme os prazos abaixo.",
    ...extra,
  };
}

class RecordingEmail {
  readonly id = "recording";
  sent: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.sent.push(msg);
  }
}

async function payWithEmail(user: Parameters<typeof buyAndPay>[0], eventId: string, ticketTypeId: string, quantity: number, buyerEmail: string) {
  const order = await createOrder(db, user, orderInput(eventId, [{ ticketTypeId, quantity }], { buyerEmail }), { providerIsSimulated: true });
  const payment = await startPayment(db, adapter, user, order.id, "PIX");
  await handlePaymentWebhook(db, adapter, await adapter.simulate(payment.providerPaymentId!, "approve"));
  return order;
}

/** Evento publicado (pelo serviço, com local próprio) e um tipo de ingresso. */
async function publishedEvent(extra: Record<string, unknown> = {}) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const input = await eventInput(extra);
  const event = await createEvent(db, owner, org.id, input);
  const tt = await db.ticketType.create({ data: { eventId: event.id, name: "Inteira", kind: "GENERAL", priceCents: 5000, quantityTotal: 50 } });
  await db.event.update({ where: { id: event.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
  return { owner, org, input, event, tt };
}

async function soldEvent() {
  const base = await publishedEvent();
  const customer = await makeUser();
  const order = await payWithEmail(customer, base.event.id, base.tt.id, 2, "maria@test.local");
  return { ...base, customer, order };
}

describe("Z — alteração relevante de evento com vendas (R8)", () => {
  it("edição comum de evento com vendas segue sem motivo e sem registro", async () => {
    const { owner, input, event } = await soldEvent();
    const updated = await updateEvent(db, owner, event.id, { ...input, title: "Show com novo título", capacity: 120 });
    expect(updated.title).toBe("Show com novo título");
    expect(updated.venueId).toBe(event.venueId); // reenviar o mesmo "novo local" não troca o local
    expect(await db.eventChange.count()).toBe(0);
  });

  it("sem pedido pago (ou fora de PUBLISHED), mudar a data não exige motivo", async () => {
    const { owner, input, event } = await publishedEvent();
    await updateEvent(db, owner, event.id, { ...input, ...when(12) });
    const draft = await createEvent(db, owner, event.organizationId, input);
    await updateEvent(db, owner, draft.id, { ...input, ...when(15) });
    expect(await db.eventChange.count()).toBe(0);
  });

  it("mudar o início exige motivo; sem ele nada muda", async () => {
    const { owner, input, event } = await soldEvent();
    await expect(updateEvent(db, owner, event.id, { ...input, ...when(12) })).rejects.toThrow(CHANGE_REASON_REQUIRED);
    await expect(updateEvent(db, owner, event.id, { ...input, ...when(12), changeReason: "curto" })).rejects.toThrow(/pelo menos 10 caracteres/);
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).startsAt).toEqual(event.startsAt);
    expect(await db.eventChange.count()).toBe(0);
  });

  it("grava EventChange com antes/depois, motivo, autor, auditoria e janela limitada ao novo início", async () => {
    const { owner, input, event } = await soldEvent();
    const reason = "A atração principal remarcou a apresentação.";
    const updated = await updateEvent(db, owner, event.id, { ...input, ...when(12), changeReason: `  ${reason}  ` });
    const [change] = await db.eventChange.findMany();
    expect(change).toMatchObject({
      eventId: event.id,
      organizationId: event.organizationId,
      actorUserId: owner.id,
      changedFields: ["startsAt"],
      reason,
      relevant: true,
      extendsChangeId: null,
    });
    expect(change.before).toMatchObject({ startsAt: event.startsAt.toISOString(), locationType: "VENUE", venueName: "Casa de Shows", cityName: "São Paulo – SP" });
    expect(change.after).toMatchObject({ startsAt: updated.startsAt.toISOString() });
    // 30 dias depois passaria do novo início (12 dias): a janela vai até o início.
    expect(change.refundUntil).toEqual(updated.startsAt);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "event.relevant_change" } });
    expect(log).toMatchObject({ entityId: change.id, actorUserId: owner.id });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "event.updated", entityId: event.id } })).toMatchObject({ metadata: { eventChangeId: change.id } });

    // Início distante: a janela é de N dias a partir da alteração.
    await updateEvent(db, owner, event.id, { ...input, ...when(90), salesEndLocal: input.salesEndLocal, changeReason: reason });
    const later = await db.eventChange.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(later.refundUntil!.getTime()).toBe(later.createdAt.getTime() + REFUND_WINDOW_DAYS_AFTER_CHANGE * DAY);
  });

  it("troca de local, de cidade ou para online é relevante; o link online não vai para o histórico", async () => {
    const { owner, input, event } = await soldEvent();
    const rio = await db.city.create({ data: { slug: "rio-de-janeiro-rj", name: "Rio de Janeiro", state: "RJ", timezone: "America/Sao_Paulo" } });
    const reason = "O local original foi interditado pela prefeitura.";
    await updateEvent(db, owner, event.id, { ...input, newVenue: { ...input.newVenue, name: "Arena Rio", cityId: rio.id }, changeReason: reason });
    await updateEvent(db, owner, event.id, { ...input, locationType: "ONLINE", newVenue: undefined, onlineUrl: "https://stream.test/segredo", changeReason: reason });
    const [toRio, toOnline] = await db.eventChange.findMany({ orderBy: { createdAt: "asc" } });
    expect(toRio.changedFields).toEqual(["venue", "city"]);
    expect(toRio.after).toMatchObject({ venueName: "Arena Rio", cityName: "Rio de Janeiro – RJ" });
    expect(toOnline.changedFields).toEqual(["venue", "city", "locationType"]);
    expect(toOnline.after).toMatchObject({ locationType: "ONLINE", venueId: null });
    expect(JSON.stringify([toOnline.before, toOnline.after])).not.toContain("stream.test");
    expect(JSON.stringify([toOnline.before, toOnline.after])).not.toContain("maria@test.local");
  });

  it("EventChange é somente inserção", async () => {
    const { owner, input, event } = await soldEvent();
    await updateEvent(db, owner, event.id, { ...input, ...when(12), changeReason: "Mudança de data pela produção." });
    const change = await db.eventChange.findFirstOrThrow();
    await expect(db.eventChange.update({ where: { id: change.id }, data: { reason: "outro motivo qualquer" } })).rejects.toThrow(/somente inserção/);
    await expect(db.eventChange.delete({ where: { id: change.id } })).rejects.toThrow(/somente inserção/);
  });

  it("avisa compradores e titulares com pedido pago antes da alteração, com o que mudou e o prazo", async () => {
    const { owner, input, event, tt, customer } = await soldEvent();
    const other = await makeUser();
    await payWithEmail(other, event.id, tt.id, 1, "joao@test.local");
    const reason = "A atração principal remarcou a apresentação.";
    await updateEvent(db, owner, event.id, { ...input, ...when(12), changeReason: reason });
    const change = await db.eventChange.findFirstOrThrow();
    // Comprou depois da alteração: já sabia, não recebe aviso nem janela.
    await payWithEmail(await makeUser(), event.id, tt.id, 1, "depois@test.local");

    const email = new RecordingEmail();
    expect(await notifyEventChange(db, change.id, email)).toEqual({ sent: 4, failed: 0 });
    expect(email.sent.map((m) => m.to).sort()).toEqual(["joao@test.local", "maria@test.local", customer.email, other.email].sort());
    const msg = email.sent.find((m) => m.to === "maria@test.local")!;
    expect(msg.subject).toBe(`Alteração no evento: ${input.title}`);
    expect(msg.text).toContain(reason);
    expect(msg.text).toContain("Data e horário de início:");
    expect(msg.text).toMatch(/Reembolso integral até \d{2}\/\d{2}\/\d{4}/);
    expect(msg.html).toContain("/meus-pedidos");
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "event.change_notified" } })).toMatchObject({
      entityId: change.id,
      metadata: { recipients: 4, sent: 4, failed: 0 },
    });
  });

  it("prorroga uma janela aberta (sempre apontando para a original) e recusa prazo menor, após o início ou janela encerrada", async () => {
    const { owner, org, input, event } = await soldEvent();
    const reason = "A atração principal remarcou a apresentação.";
    await updateEvent(db, owner, event.id, { ...input, ...when(90), changeReason: reason });
    const root = await db.eventChange.findFirstOrThrow();
    const start = (await db.event.findUniqueOrThrow({ where: { id: event.id } })).startsAt;

    const ext1 = await extendEventChangeWindow(db, owner, root.id, { refundUntil: new Date(Date.now() + 45 * DAY), reason: "Mais prazo para os compradores." });
    expect(ext1).toMatchObject({ extendsChangeId: root.id, changedFields: [], relevant: true });
    const ext2 = await extendEventChangeWindow(db, owner, ext1.id, { refundUntil: new Date(Date.now() + 50 * DAY), reason: "Mais prazo para os compradores." });
    expect(ext2.extendsChangeId).toBe(root.id);
    expect(ext2.before).toEqual({ refundUntil: ext1.refundUntil!.toISOString() });

    await expect(extendEventChangeWindow(db, owner, root.id, { refundUntil: new Date(Date.now() + 40 * DAY), reason: "Prazo menor que o vigente." })).rejects.toThrow(/depois do prazo atual/);
    await expect(extendEventChangeWindow(db, owner, root.id, { refundUntil: new Date(start.getTime() + 60_000), reason: "Depois do início do evento." })).rejects.toThrow(/início do evento/);
    await expect(extendEventChangeWindow(db, owner, root.id, { refundUntil: new Date(Date.now() + 60 * DAY), reason: "" })).rejects.toThrow(CHANGE_REASON_REQUIRED);

    const finance = await makeUser();
    await db.organizationMember.create({ data: { organizationId: org.id, userId: finance.id, role: "FINANCE" } });
    await expect(extendEventChangeWindow(db, finance, root.id, { refundUntil: new Date(Date.now() + 60 * DAY), reason: "Sem permissão de edição." })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const closed = await db.eventChange.create({
      data: {
        eventId: event.id,
        organizationId: org.id,
        changedFields: ["startsAt"],
        before: {},
        after: {},
        reason: "Alteração antiga.",
        relevant: true,
        createdAt: new Date(Date.now() - 10 * DAY),
        refundUntil: new Date(Date.now() - DAY),
      },
    });
    await expect(extendEventChangeWindow(db, owner, closed.id, { refundUntil: new Date(Date.now() + 5 * DAY), reason: "Reabrir janela encerrada." })).rejects.toThrow(/já terminou/);

    const history = await listEventChanges(db, owner, event.id);
    const rootView = history.find((h) => h.id === root.id)!;
    expect(rootView).toMatchObject({ windowOpen: true, effectiveRefundUntil: ext2.refundUntil });
    expect(history.find((h) => h.id === closed.id)!.windowOpen).toBe(false);
    expect(await db.auditLog.count({ where: { action: "event.change_window_extended" } })).toBe(2);

    const email = new RecordingEmail();
    await notifyEventChange(db, ext2.id, email);
    expect(email.sent[0].subject).toBe(`Prazo de reembolso prorrogado: ${input.title}`);
  });
});

describe("Z — limite de ingressos por conta (R4)", () => {
  it("guarda o limite opcional (vazio = sem limite) e recusa valores inválidos", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    expect((await createEvent(db, owner, org.id, await eventInput({ maxTicketsPerAccount: "4" }))).maxTicketsPerAccount).toBe(4);
    expect((await createEvent(db, owner, org.id, await eventInput({ maxTicketsPerAccount: "" }))).maxTicketsPerAccount).toBeNull();
    for (const bad of ["0", "-1", "2.5", "1001"]) await expect(createEvent(db, owner, org.id, await eventInput({ maxTicketsPerAccount: bad }))).rejects.toThrow();
  });

  it("com vendas, não pode ficar abaixo do que uma conta já tem (pagos + reservas ativas)", async () => {
    const { owner, input, event, tt } = await soldEvent(); // uma conta com 2 ingressos pagos
    await expect(updateEvent(db, owner, event.id, { ...input, maxTicketsPerAccount: 1 })).rejects.toThrow(/Uma conta já tem 2 ingressos/);
    expect((await updateEvent(db, owner, event.id, { ...input, maxTicketsPerAccount: 2 })).maxTicketsPerAccount).toBe(2);
    expect((await updateEvent(db, owner, event.id, { ...input, maxTicketsPerAccount: "" })).maxTicketsPerAccount).toBeNull();

    // Pedido aguardando pagamento também conta.
    const pending = await makeUser();
    await createOrder(db, pending, orderInput(event.id, [{ ticketTypeId: tt.id, quantity: 4 }], { idempotencyKey: randomUUID() }), { providerIsSimulated: true });
    await expect(updateEvent(db, owner, event.id, { ...input, maxTicketsPerAccount: 3 })).rejects.toThrow(/Uma conta já tem 4 ingressos/);
    expect((await updateEvent(db, owner, event.id, { ...input, maxTicketsPerAccount: 4 })).maxTicketsPerAccount).toBe(4);
  });
});
