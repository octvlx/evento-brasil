import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setupEvent() {
  const owner = await makeUser();
  return makeEvent(await makeOrg(owner));
}

describe("política de transferência por evento — garantias do banco", () => {
  it("novos eventos recebem os padrões de 24 horas, uma transferência e sem retorno", async () => {
    const event = await setupEvent();
    expect(event.transferDeadlineHours).toBe(24);
    expect(event.transferMaxTransfers).toBe(1);
    expect(event.transferAllowReturn).toBe(false);
  });

  it("a migração aplica os mesmos padrões a eventos já existentes sem alterar seus dados", async () => {
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261028180000_event_transfer_policy/migration.sql"), "utf8");
    // Relação temporária privada da transação: simula uma tabela anterior às novas
    // colunas sem remover colunas ou dados da tabela compartilhada dos testes.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE "Event" (id TEXT PRIMARY KEY, title TEXT NOT NULL) ON COMMIT DROP');
      await tx.$executeRaw`INSERT INTO "Event" (id, title) VALUES ('legacy-event', 'Evento existente')`;
      for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
        await tx.$executeRawUnsafe(statement);
      }
      const rows = await tx.$queryRaw<{ id: string; title: string; transferDeadlineHours: number; transferMaxTransfers: number; transferAllowReturn: boolean }[]>`SELECT * FROM "Event"`;
      expect(rows).toEqual([{
        id: "legacy-event", title: "Evento existente",
        transferDeadlineHours: 24, transferMaxTransfers: 1, transferAllowReturn: false,
      }]);
    });
  });

  it("recusa limites fora da faixa no SQL e aceita os extremos permitidos", async () => {
    const event = await setupEvent();
    for (const hours of [-1, 8761]) {
      await expect(db.$executeRaw`UPDATE "Event" SET "transferDeadlineHours" = ${hours} WHERE id = ${event.id}`)
        .rejects.toThrow(/Event_transfer_deadline_hours_range/);
    }
    for (const count of [0, 11]) {
      await expect(db.$executeRaw`UPDATE "Event" SET "transferMaxTransfers" = ${count} WHERE id = ${event.id}`)
        .rejects.toThrow(/Event_transfer_max_transfers_range/);
    }
    for (const [hours, count] of [[0, 1], [8760, 10]]) {
      const updated = await db.event.update({ where: { id: event.id }, data: {
        transferDeadlineHours: hours, transferMaxTransfers: count, transferAllowReturn: true,
      } });
      expect([updated.transferDeadlineHours, updated.transferMaxTransfers, updated.transferAllowReturn]).toEqual([hours, count, true]);
    }
  });

  it("campos da política não aceitam NULL mesmo em escrita SQL direta", async () => {
    const event = await setupEvent();
    for (const field of ["transferDeadlineHours", "transferMaxTransfers", "transferAllowReturn"]) {
      await expect(db.$executeRawUnsafe(`UPDATE "Event" SET "${field}" = NULL WHERE id = $1`, event.id))
        .rejects.toThrow(new RegExp(field));
    }
  });

  it("reduzir o limite não apaga transferências aceitas nem altera o titular atual", async () => {
    const event = await setupEvent();
    await db.event.update({ where: { id: event.id }, data: { transferMaxTransfers: 5, transferAllowReturn: true } });
    const buyer = await makeUser();
    const recipient = await makeUser();
    const finalHolder = await makeUser();
    const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
    for (const [from, to] of [[buyer, recipient], [recipient, finalHolder]]) {
      await db.ticketTransfer.create({ data: {
        ticketId: ticket.id, eventId: event.id, fromUserId: from.id,
        fromHolderName: from.name, fromHolderEmail: from.email,
        toUserId: to.id, toEmail: to.email, toHolderName: to.name,
        tokenHash: randomBytes(32).toString("hex"), status: "ACCEPTED",
        createdById: from.id, decidedById: to.id, decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      } });
    }
    await db.issuedTicket.update({ where: { id: ticket.id }, data: { holderUserId: finalHolder.id } });
    const before = await db.ticketTransfer.findMany({ where: { ticketId: ticket.id }, orderBy: { id: "asc" } });
    await db.event.update({ where: { id: event.id }, data: { transferMaxTransfers: 1, transferAllowReturn: false } });
    expect(await db.ticketTransfer.findMany({ where: { ticketId: ticket.id }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({ holderUserId: finalHolder.id });
  });
});
