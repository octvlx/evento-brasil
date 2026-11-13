// Organizador: duplicar evento numa nova data e despublicar (voltar a rascunho).
import { beforeEach, describe, expect, it } from "vitest";
import { duplicateEvent, submitEventForPublication, unpublishEvent } from "@/server/services/events";
import { cancelEvent } from "@/server/services/cancellation";
import { utcToZonedLocalInput } from "@/lib/datetime";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const DAY = 86_400_000;

async function setup() {
  const owner = await makeUser();
  const finance = await makeUser();
  const outsider = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: finance.id, role: "FINANCE" }] });
  const event = await makeEvent(org, { startsInDays: 10, tickets: [{ priceCents: 5000, quantityTotal: 20 }, { priceCents: 0, quantityTotal: 5 }] });
  return { owner, finance, outsider, org, event };
}

describe("duplicar evento", () => {
  it("cria rascunho com as datas deslocadas e tipos de ingresso zerados", async () => {
    const { owner, event } = await setup();
    // A origem tem vendas: a cópia não herda contadores.
    await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    const tt = event.ticketTypes[0];
    await db.ticketType.update({ where: { id: tt.id }, data: { salesEndAt: new Date(event.startsAt.getTime() - DAY) } });
    const source = await db.event.findUniqueOrThrow({ where: { id: event.id }, include: { ticketTypes: { orderBy: { sortOrder: "asc" } } } });

    const newStart = new Date(source.startsAt.getTime() + 35 * DAY);
    const copy = await duplicateEvent(db, owner, event.id, utcToZonedLocalInput(newStart, source.timezone));
    // O campo tem precisão de minuto; o intervalo vale para todas as datas.
    const shift = copy.startsAt.getTime() - source.startsAt.getTime();
    expect(Math.abs(shift - 35 * DAY)).toBeLessThan(60_000);

    expect(copy.id).not.toBe(event.id);
    expect(copy.slug).not.toBe(source.slug);
    expect(copy).toMatchObject({ status: "DRAFT", title: source.title, organizationId: source.organizationId, venueId: source.venueId, capacity: source.capacity, publishedAt: null });
    expect(copy.endsAt.getTime() - source.endsAt.getTime()).toBe(shift);
    expect(copy.salesStartAt.getTime() - source.salesStartAt.getTime()).toBe(shift);
    expect(copy.salesEndAt.getTime() - source.salesEndAt.getTime()).toBe(shift);

    const types = await db.ticketType.findMany({ where: { eventId: copy.id }, orderBy: { sortOrder: "asc" } });
    expect(types).toHaveLength(2);
    expect(types[0]).toMatchObject({ name: tt.name, priceCents: 5000, quantityTotal: 20, quantitySold: 0, quantityReserved: 0, quantityRefunded: 0 });
    expect(types[0].salesEndAt!.getTime() - source.ticketTypes[0].salesEndAt!.getTime()).toBe(shift);
    // A origem fica intacta.
    expect((await db.ticketType.findUniqueOrThrow({ where: { id: tt.id } })).quantitySold).toBe(2);

    const log = await db.auditLog.findFirstOrThrow({ where: { entityId: copy.id, action: "event.duplicated" } });
    expect(log.metadata).toMatchObject({ sourceEventId: event.id, ticketTypes: 2 });
    // Sem progresso de assistente: a cópia abre na tela de gestão e segue a publicação normal.
    expect((await submitEventForPublication(db, owner, copy.id)).status).toBe("PENDING_REVIEW");
  });

  it("não copia o regime de meia-entrada, que só o admin define", async () => {
    const { owner, event } = await setup();
    await db.event.update({ where: { id: event.id }, data: { halfPriceRegime: "NOT_SUBJECT", halfPriceRegimeNote: "isento" } });
    const copy = await duplicateEvent(db, owner, event.id, utcToZonedLocalInput(new Date(Date.now() + 40 * DAY), event.timezone));
    expect(copy).toMatchObject({ halfPriceRegime: "FEDERAL", halfPriceRegimeNote: null });
  });

  it("recusa data no passado ou inválida", async () => {
    const { owner, event } = await setup();
    await expect(duplicateEvent(db, owner, event.id, utcToZonedLocalInput(new Date(Date.now() - DAY), event.timezone))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(duplicateEvent(db, owner, event.id, "amanhã")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.event.count()).toBe(1);
  });

  it("exige permissão de edição na organização do evento", async () => {
    const { finance, outsider, event } = await setup();
    const when = utcToZonedLocalInput(new Date(Date.now() + 40 * DAY), event.timezone);
    await expect(duplicateEvent(db, finance, event.id, when)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(duplicateEvent(db, outsider, event.id, when)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    expect(await db.event.count()).toBe(1);
  });

  it("duplica evento cancelado ou já encerrado (caso de evento que se repete)", async () => {
    const { owner, event } = await setup();
    await cancelEvent(db, adapter, owner, event.id, "Chuva forte", { autoRefund: false });
    const copy = await duplicateEvent(db, owner, event.id, utcToZonedLocalInput(new Date(Date.now() + 40 * DAY), event.timezone));
    expect(copy).toMatchObject({ status: "DRAFT", cancelledAt: null, cancellationReason: null });
  });
});

describe("despublicar evento", () => {
  it("publicado sem vendas volta a rascunho e sai da venda", async () => {
    const { owner, event } = await setup();
    const updated = await unpublishEvent(db, owner, event.id);
    expect(updated).toMatchObject({ status: "DRAFT", publishedAt: null });
    expect(await db.auditLog.count({ where: { entityId: event.id, action: "event.unpublished" } })).toBe(1);
    // Compra depois de despublicar é recusada.
    await expect(buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }])).rejects.toThrow(/indisponível/);
    // Pode enviar de novo (organização sem publicação automática: volta à moderação).
    expect((await submitEventForPublication(db, owner, event.id)).status).toBe("PENDING_REVIEW");
  });

  it("recusa com ingresso vendido ou pedido aguardando pagamento", async () => {
    const { owner, event } = await setup();
    const order = await buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await expect(unpublishEvent(db, owner, event.id)).rejects.toThrow(/aguardando pagamento/);
    await db.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    await buyAndPay(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await expect(unpublishEvent(db, owner, event.id)).rejects.toThrow(/cancele o evento/);
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("PUBLISHED");
  });

  it("em moderação volta a rascunho; rascunho, encerrado e cancelado são recusados", async () => {
    const { owner, org, event } = await setup();
    await db.event.update({ where: { id: event.id }, data: { status: "PENDING_REVIEW" } });
    expect((await unpublishEvent(db, owner, event.id)).status).toBe("DRAFT");
    await expect(unpublishEvent(db, owner, event.id)).rejects.toMatchObject({ code: "INVALID_STATE" });

    const past = await makeEvent(org, { startsAt: new Date(Date.now() - 2 * DAY), salesStartAt: new Date(Date.now() - 5 * DAY) });
    await db.event.update({ where: { id: past.id }, data: { endsAt: new Date(Date.now() - DAY), salesEndAt: new Date(Date.now() - DAY - 60_000) } });
    await expect(unpublishEvent(db, owner, past.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("exige permissão de publicação", async () => {
    const { finance, outsider, event } = await setup();
    await expect(unpublishEvent(db, finance, event.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(unpublishEvent(db, outsider, event.id)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
  });

  it("compra e despublicação ao mesmo tempo: nunca fica ingresso num evento em rascunho", async () => {
    const { owner, event } = await setup();
    const buyer = await makeUser();
    for (let i = 0; i < 5; i++) {
      await db.event.update({ where: { id: event.id }, data: { status: "PUBLISHED" } });
      await db.order.updateMany({ where: { eventId: event.id, status: "PENDING_PAYMENT" }, data: { status: "CANCELLED" } });
      await Promise.allSettled([
        buy(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]),
        unpublishEvent(db, owner, event.id),
      ]);
      const ev = await db.event.findUniqueOrThrow({ where: { id: event.id } });
      const pending = await db.order.count({ where: { eventId: event.id, status: "PENDING_PAYMENT" } });
      // Ou a compra ganhou (evento segue publicado) ou a despublicação ganhou (sem pedido).
      if (ev.status === "DRAFT") expect(pending).toBe(0);
    }
  });
});
