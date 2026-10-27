// ADR 0003 (Fase 2 do Decreto 13.108/2026): garantias do banco para transferência,
// alterações de evento, pedidos de cancelamento, termos e limite por conta.
// Regras de negócio e prazos são da Fase 3 (serviços).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const sha256 = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const recipient = await makeUser();
  const admin = await makeUser({ admin: true });
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
  const [ticket, ticket2] = await db.issuedTicket.findMany({ where: { orderId: order.id }, orderBy: { sequence: "asc" } });
  const transfer = (data: Record<string, unknown> = {}) =>
    db.ticketTransfer.create({
      data: {
        ticketId: ticket.id,
        eventId: event.id,
        fromUserId: buyer.id,
        fromHolderName: "Comprador",
        fromHolderEmail: "comprador@test.local",
        toEmail: "destino@test.local",
        tokenHash: sha256(),
        createdById: buyer.id,
        expiresAt: days(2),
        ...data,
      },
    });
  return { owner, org, event, buyer, recipient, admin, order, ticket, ticket2, transfer };
}

describe("U — schema de conformidade (ADR 0003)", () => {
  it("holderUserId: ingresso emitido nasce com o comprador; o backfill da migração usa o comprador do pedido", async () => {
    const { buyer, recipient, order, ticket, ticket2 } = await setup();
    expect(ticket.holderUserId).toBe(buyer.id);
    expect(ticket2.holderUserId).toBe(order.userId);

    await db.issuedTicket.update({ where: { id: ticket.id }, data: { holderUserId: recipient.id } });
    // Executa o UPDATE de backfill exatamente como está na migração.
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261027180000_compliance_schema/migration.sql"), "utf8");
    const backfill = sql.match(/UPDATE "IssuedTicket" t SET "holderUserId" = o\."userId"[^;]*;/)?.[0];
    expect(backfill).toBeDefined();
    await db.$executeRawUnsafe(backfill!);
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } })).holderUserId).toBe(order.userId);

    await expect(db.$executeRaw`UPDATE "IssuedTicket" SET "holderUserId" = NULL WHERE id = ${ticket.id}`).rejects.toThrow(/holderUserId/);
  });

  it("TicketTransfer: só a transição PENDING → decidida; decidida não muda nem é apagada", async () => {
    const { recipient, transfer } = await setup();
    const t = await transfer();

    await expect(transfer({ toEmail: "outro@test.local", tokenHash: sha256() })).rejects.toThrow(/TicketTransfer_one_pending_per_ticket/);
    await expect(db.ticketTransfer.update({ where: { id: t.id }, data: { toEmail: "x@test.local", status: "CANCELLED", decidedAt: new Date() } })).rejects.toThrow(/dados do pedido não mudam/);
    await expect(db.ticketTransfer.update({ where: { id: t.id }, data: { decisionReason: "sem decidir" } })).rejects.toThrow(/só para decidir/);
    await expect(db.ticketTransfer.update({ where: { id: t.id }, data: { status: "ACCEPTED", decidedAt: new Date() } })).rejects.toThrow(/TicketTransfer_accepted_recipient/);
    await expect(db.ticketTransfer.update({ where: { id: t.id }, data: { status: "EXPIRED" } })).rejects.toThrow(/TicketTransfer_decision_state/);

    await db.ticketTransfer.update({
      where: { id: t.id },
      data: { status: "ACCEPTED", decidedAt: new Date(), toUserId: recipient.id, toHolderName: "Destino", decidedById: recipient.id, previousTokenHash: sha256() },
    });
    await expect(db.ticketTransfer.update({ where: { id: t.id }, data: { decisionReason: "ajuste" } })).rejects.toThrow(/linha imutável/);
    await expect(db.ticketTransfer.update({ where: { id: t.id }, data: { status: "CANCELLED" } })).rejects.toThrow(/linha imutável/);
    await expect(db.ticketTransfer.delete({ where: { id: t.id } })).rejects.toThrow(/DELETE bloqueado/);
    // Pendente também não pode ser apagada.
    const pending = await transfer();
    await expect(db.ticketTransfer.delete({ where: { id: pending.id } })).rejects.toThrow(/DELETE bloqueado/);
  });

  it("TicketTransfer: CHECKs do pedido do titular e da reversão pelo admin", async () => {
    const { buyer, recipient, admin, event, ticket, transfer } = await setup();
    await expect(transfer({ toEmail: "Destino@Test.local" })).rejects.toThrow(/TicketTransfer_to_email_lower/);
    await expect(transfer({ tokenHash: "token-em-texto-claro" })).rejects.toThrow(/TicketTransfer_hash_format/);
    await expect(transfer({ tokenHash: null })).rejects.toThrow(/TicketTransfer_holder_request/);
    await expect(transfer({ expiresAt: null })).rejects.toThrow(/TicketTransfer_holder_request/);
    await expect(transfer({ createdById: admin.id })).rejects.toThrow(/TicketTransfer_holder_request/);
    await expect(transfer({ toUserId: buyer.id })).rejects.toThrow(/TicketTransfer_distinct_parties/);

    const accepted = await transfer({ status: "ACCEPTED", decidedAt: new Date(), toUserId: recipient.id, toHolderName: "Destino" });
    const reversal = (data: Record<string, unknown> = {}) =>
      db.ticketTransfer.create({
        data: {
          ticketId: ticket.id,
          eventId: event.id,
          initiatedBy: "ADMIN",
          fromUserId: recipient.id,
          fromHolderName: "Destino",
          fromHolderEmail: "destino@test.local",
          toUserId: buyer.id,
          toEmail: "comprador@test.local",
          toHolderName: "Comprador",
          status: "ACCEPTED",
          createdById: admin.id,
          decidedById: admin.id,
          decidedAt: new Date(),
          reversesTransferId: accepted.id,
          reason: "Fraude confirmada",
          ...data,
        },
      });
    await expect(reversal({ reason: null })).rejects.toThrow(/TicketTransfer_admin_action/);
    await expect(reversal({ tokenHash: sha256() })).rejects.toThrow(/TicketTransfer_admin_action/);
    await expect(reversal({ status: "PENDING", decidedAt: null })).rejects.toThrow(/TicketTransfer_admin_action/);
    await reversal();
    // Uma transferência só é revertida uma vez.
    await expect(reversal()).rejects.toThrow();
  });

  it("sem cascata: ingresso, usuário e evento com histórico de transferência não podem ser apagados", async () => {
    const { buyer, recipient, event, ticket, transfer } = await setup();
    const t = await transfer({ status: "CANCELLED", decidedAt: new Date(), decidedById: buyer.id, toUserId: recipient.id });

    await expect(db.issuedTicket.delete({ where: { id: ticket.id } })).rejects.toThrow();
    await expect(db.user.delete({ where: { id: recipient.id } })).rejects.toThrow();
    await expect(db.user.delete({ where: { id: buyer.id } })).rejects.toThrow();
    await expect(db.event.delete({ where: { id: event.id } })).rejects.toThrow();
    expect(await db.ticketTransfer.findUnique({ where: { id: t.id } })).not.toBeNull();
  });

  it("EventChange é somente inserção, com FK composta e janela coerente", async () => {
    const { org, owner, event } = await setup();
    const other = await makeOrg(await makeUser());
    const change = (data: Record<string, unknown> = {}) =>
      db.eventChange.create({
        data: {
          eventId: event.id,
          organizationId: org.id,
          actorUserId: owner.id,
          changedFields: ["startsAt"],
          before: { startsAt: "2026-12-01T20:00:00.000Z" },
          after: { startsAt: "2026-12-08T20:00:00.000Z" },
          reason: "Adiado por motivo de força maior",
          relevant: true,
          refundUntil: days(30),
          ...data,
        },
      });
    await expect(change({ organizationId: other.id })).rejects.toThrow();
    await expect(change({ reason: "   " })).rejects.toThrow(/EventChange_reason_present/);
    await expect(change({ refundUntil: days(-1) })).rejects.toThrow(/EventChange_refund_window/);

    const c = await change();
    await expect(change({ changedFields: [], before: {}, after: {}, reason: "Prorroga", refundUntil: null, extendsChangeId: c.id })).rejects.toThrow(/EventChange_extension/);
    await change({ changedFields: [], before: {}, after: {}, reason: "Prorroga", refundUntil: days(45), extendsChangeId: c.id });

    await expect(db.eventChange.update({ where: { id: c.id }, data: { reason: "outro" } })).rejects.toThrow(/somente inserção/);
    await expect(db.eventChange.delete({ where: { id: c.id } })).rejects.toThrow(/somente inserção/);
  });

  it("Refund EVENT_CHANGED exige a alteração e só ela", async () => {
    const { org, event, order } = await setup();
    const c = await db.eventChange.create({
      data: { eventId: event.id, organizationId: org.id, changedFields: ["venueId"], before: {}, after: {}, reason: "Troca de local", refundUntil: days(10) },
    });
    const refund = (data: Record<string, unknown>) => db.refund.create({ data: { orderId: order.id, amountCents: 100, idempotencyKey: `t:${Math.random()}`, ...data } as never });
    await expect(refund({ reason: "EVENT_CHANGED" })).rejects.toThrow(/Refund_event_change_link/);
    await expect(refund({ reason: "CUSTOMER_REQUEST", eventChangeId: c.id })).rejects.toThrow(/Refund_event_change_link/);
    await refund({ reason: "EVENT_CHANGED", eventChangeId: c.id });
  });

  it("CancellationRequest: protocolo único e com formato; um aberto por pedido; decidido congelado", async () => {
    const { buyer, admin, org, event, order } = await setup();
    const request = (protocol: string, data: Record<string, unknown> = {}) =>
      db.cancellationRequest.create({
        data: { protocol, orderId: order.id, eventId: event.id, organizationId: org.id, requestedById: buyer.id, reason: "Desisti da compra", ...data },
      });
    await expect(request("CAN-1")).rejects.toThrow(/CancellationRequest_protocol_format/);
    await expect(request("CAN-20261027-ILOU12")).rejects.toThrow(/CancellationRequest_protocol_format/);

    const r = await request("CAN-20261027-7KQ2M9");
    await expect(request("CAN-20261027-7KQ2MA")).rejects.toThrow(/CancellationRequest_one_open_per_order/);

    await db.cancellationRequest.update({ where: { id: r.id }, data: { status: "WITHDRAWN", decidedAt: new Date(), decidedById: buyer.id } });
    // Protocolo único mesmo entre pedidos diferentes / depois de decidido.
    const { order: order2 } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
    await expect(request("CAN-20261027-7KQ2M9", { orderId: order2.id })).rejects.toThrow(/protocol/);

    const r2 = await request("CAN-20261027-7KQ2MB");
    await db.cancellationRequest.update({ where: { id: r2.id }, data: { respondBy: days(5) } });
    await expect(db.cancellationRequest.update({ where: { id: r2.id }, data: { respondBy: days(50) } })).rejects.toThrow(/prazo de resposta já definido/);
    await expect(db.cancellationRequest.update({ where: { id: r2.id }, data: { reason: "editado" } })).rejects.toThrow(/dados do pedido não mudam/);
    await expect(db.cancellationRequest.update({ where: { id: r2.id }, data: { status: "REJECTED", decidedAt: new Date(), decidedById: admin.id } })).rejects.toThrow(/CancellationRequest_rejection_note/);
    await expect(db.cancellationRequest.update({ where: { id: r2.id }, data: { status: "WITHDRAWN", decidedAt: new Date(), decidedById: admin.id } })).rejects.toThrow(/CancellationRequest_withdrawn_by_requester/);
    await db.cancellationRequest.update({ where: { id: r2.id }, data: { status: "APPROVED", decidedAt: new Date(), decidedById: admin.id } });
    await expect(db.cancellationRequest.update({ where: { id: r2.id }, data: { decisionNote: "depois" } })).rejects.toThrow(/linha imutável/);
    await expect(db.cancellationRequest.delete({ where: { id: r2.id } })).rejects.toThrow(/DELETE bloqueado/);
  });

  it("TermsVersion e TermsAcceptance são somente inserção, com contexto coerente", async () => {
    const { buyer, owner, org, order } = await setup();
    const v = await db.termsVersion.create({ data: { kind: "BUYER", version: "2026-10-rascunho", textHash: sha256(), documentPath: "/termos", publishedAt: new Date() } });
    expect(v.isDraft).toBe(true);
    await expect(db.termsVersion.create({ data: { kind: "BUYER", version: "x", textHash: "abc", publishedAt: new Date() } })).rejects.toThrow(/TermsVersion_text_hash_format/);

    const accept = (data: Record<string, unknown>) => db.termsAcceptance.create({ data: { userId: buyer.id, termsVersionId: v.id, ...data } as never });
    await expect(accept({ context: "CHECKOUT" })).rejects.toThrow(/TermsAcceptance_checkout_order/);
    await expect(accept({ context: "SIGNUP", orderId: order.id })).rejects.toThrow(/TermsAcceptance_checkout_order/);
    await expect(accept({ context: "ORGANIZER_SIGNUP" })).rejects.toThrow(/TermsAcceptance_organization/);
    await expect(accept({ context: "SIGNUP", organizationId: org.id })).rejects.toThrow(/TermsAcceptance_organization/);

    const a = await accept({ context: "CHECKOUT", orderId: order.id, ip: "203.0.113.7" });
    await expect(accept({ context: "CHECKOUT", orderId: order.id })).rejects.toThrow(/TermsAcceptance_order_once/);
    // Um registro por evento de aceite: cadastro e reaceite podem repetir.
    await accept({ context: "SIGNUP" });
    await accept({ context: "REACCEPT" });
    await db.termsAcceptance.create({ data: { userId: owner.id, termsVersionId: v.id, context: "ORGANIZER_SIGNUP", organizationId: org.id } });
    await expect(db.termsAcceptance.create({ data: { userId: owner.id, termsVersionId: v.id, context: "REACCEPT", organizationId: org.id } })).rejects.toThrow(/TermsAcceptance_organization_once/);

    await expect(db.termsAcceptance.update({ where: { id: a.id }, data: { ip: null } })).rejects.toThrow(/somente inserção/);
    await expect(db.termsAcceptance.delete({ where: { id: a.id } })).rejects.toThrow(/somente inserção/);
    await expect(db.termsVersion.update({ where: { id: v.id }, data: { isDraft: false } })).rejects.toThrow(/somente inserção/);
    await expect(db.termsVersion.delete({ where: { id: v.id } })).rejects.toThrow(/somente inserção/);
    await expect(db.user.delete({ where: { id: buyer.id } })).rejects.toThrow();
  });

  it("Event.maxTicketsPerAccount é nulo ou positivo", async () => {
    const { event } = await setup();
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).maxTicketsPerAccount).toBeNull();
    await expect(db.event.update({ where: { id: event.id }, data: { maxTicketsPerAccount: 0 } })).rejects.toThrow(/Event_max_tickets_per_account/);
    await db.event.update({ where: { id: event.id }, data: { maxTicketsPerAccount: 4 } });
  });
});
