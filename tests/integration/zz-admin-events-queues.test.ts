// Admin: suspender evento sem reembolsar, responsável por pedido de cancelamento e
// exportação CSV das filas.
import { beforeEach, describe, expect, it } from "vitest";
import { setEventSuspended, setEventFeatured, updateEvent, upsertTicketType } from "@/server/services/events";
import { getPublicEvent, searchEvents } from "@/server/services/catalog";
import { checkInTicket } from "@/server/services/checkin";
import { qrPayload } from "@/server/services/tickets";
import { assignCancellationRequest, createCancellationRequest, decideCancellationRequest, listCancellationAssignees } from "@/server/services/cancellation-requests";
import {
  cancellationQueueToCsv,
  changeWindowsToCsv,
  listCancellationQueue,
  listOpenChangeWindows,
  searchTransfers,
  transfersToCsv,
} from "@/server/services/admin-oversight";
import { adapter, buy, buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const admin = (roles: ("SUPER_ADMIN" | "FINANCE" | "MODERATION" | "SUPPORT")[], email: string) =>
  db.user.create({ data: { email, name: email, passwordHash: "x", platformRole: "ADMIN", adminRoles: roles } });

async function publishedWithSale() {
  const owner = await makeUser();
  const finance = await makeUser();
  const org = await makeOrg(owner, { extraMembers: [{ userId: finance.id, role: "FINANCE" }] });
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  return { owner, finance, org, event, buyer, order };
}

describe("suspender evento sem reembolsar", () => {
  it("sai da vitrine e das vendas, ingressos valem na portaria, organizador não edita; reativar desfaz", async () => {
    const { owner, finance, event, order } = await publishedWithSale();
    const mod = await admin(["MODERATION"], "mod@test.local");
    await setEventFeatured(db, mod, event.id, true);
    await setEventSuspended(db, mod, event.id, true, "Denúncia em análise");

    const after = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(after).toMatchObject({ status: "PUBLISHED", suspensionReason: "Denúncia em análise", suspendedById: mod.id, isFeatured: false });
    // Nada de cancelamento nem reembolso.
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await db.refund.count()).toBe(0);
    // Vitrine e página pública.
    expect((await searchEvents(db, {})).events.map((e) => e.id)).not.toContain(event.id);
    expect(await getPublicEvent(db, event.slug)).toBeNull();
    // Vendas pausadas.
    await expect(buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }])).rejects.toMatchObject({ code: "SALES_CLOSED" });
    // Ingresso já vendido continua valendo na portaria.
    const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
    expect((await checkInTicket(db, owner, event.id, qrPayload(ticket))).result).toBe("ADMITTED");
    // Organizador travado.
    await expect(updateEvent(db, owner, event.id, {} as never)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(upsertTicketType(db, owner, event.id, { name: "Extra", kind: "GENERAL", priceCents: 1000, quantityTotal: 10 })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(setEventFeatured(db, mod, event.id, true)).rejects.toMatchObject({ code: "INVALID_STATE" });
    // Só o organizador (OWNER e FINANCE) é avisado.
    const mails = await db.emailOutbox.findMany({ where: { template: "EVENT_SUSPENDED" }, select: { recipient: true } });
    expect(mails.map((m) => m.recipient).sort()).toEqual([finance.email, owner.email].sort());
    expect(await db.auditLog.findFirst({ where: { action: "event.suspended", entityId: event.id } })).toMatchObject({ actorUserId: mod.id });

    await setEventSuspended(db, mod, event.id, false);
    expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ suspendedAt: null, suspensionReason: null, suspendedById: null });
    expect((await searchEvents(db, {})).events.map((e) => e.id)).toContain(event.id);
    await expect(buy(await makeUser(), event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }])).resolves.toBeTruthy();
    expect(await db.emailOutbox.count({ where: { template: "EVENT_REINSTATED" } })).toBe(2);
  });

  it("motivo obrigatório, só publicado, e só admin de moderação", async () => {
    const { event, owner } = await publishedWithSale();
    const mod = await admin(["MODERATION"], "mod@test.local");
    await expect(setEventSuspended(db, mod, event.id, true, "  ")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setEventSuspended(db, await admin(["FINANCE"], "fin@test.local"), event.id, true, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setEventSuspended(db, owner, event.id, true, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const draft = await makeEvent(await makeOrg(await makeUser()), { status: "DRAFT" });
    await expect(setEventSuspended(db, mod, draft.id, true, "x")).rejects.toMatchObject({ code: "INVALID_STATE" });
    // Repetir é idempotente.
    await setEventSuspended(db, mod, event.id, true, "Motivo");
    await setEventSuspended(db, mod, event.id, true, "Outro");
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).suspensionReason).toBe("Motivo");
  });
});

describe("responsável pelo pedido de cancelamento", () => {
  it("assumir, atribuir a outro admin elegível, filtrar e liberar; decidido não muda", async () => {
    const { buyer, order } = await publishedWithSale();
    const a = await admin(["SUPPORT"], "a@test.local");
    const b = await admin(["SUPER_ADMIN"], "b@test.local");
    const notEligible = await admin(["MODERATION"], "m@test.local");
    const request = await createCancellationRequest(db, buyer, order.id, "Não poderei ir.");

    expect((await listCancellationAssignees(db, a)).map((u) => u.email).sort()).toEqual(["a@test.local", "b@test.local"]);
    await assignCancellationRequest(db, a, request.id, a.id);
    expect((await listCancellationQueue(db, a, { assignee: "me" })).items.map((r) => r.id)).toEqual([request.id]);
    expect((await listCancellationQueue(db, a, { assignee: "none" })).total).toBe(0);
    await expect(assignCancellationRequest(db, a, request.id, notEligible.id)).rejects.toMatchObject({ code: "VALIDATION" });
    await assignCancellationRequest(db, a, request.id, b.id);
    expect((await listCancellationQueue(db, b, { assignee: "me" })).items[0].assignedTo?.email).toBe("b@test.local");
    await assignCancellationRequest(db, b, request.id, null);
    expect((await listCancellationQueue(db, a, { assignee: "none" })).total).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: request.id, action: { in: ["cancellation.assigned", "cancellation.unassigned"] } } })).toBe(3);

    await decideCancellationRequest(db, adapter, a, request.id, { decision: "REJECT", note: "Fora do prazo." });
    await expect(assignCancellationRequest(db, a, request.id, a.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("exportação CSV das filas", () => {
  it("cancelamentos, transferências e alterações viram CSV com cabeçalho e linhas", async () => {
    const { buyer, order } = await publishedWithSale();
    const a = await admin(["SUPER_ADMIN"], "a@test.local");
    const request = await createCancellationRequest(db, buyer, order.id, "Motivo, com vírgula e \"aspas\".");
    await assignCancellationRequest(db, a, request.id, a.id);
    const queue = await listCancellationQueue(db, a, { exportAll: true });
    const csv = cancellationQueueToCsv(queue.items, false);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toContain("Protocolo");
    expect(lines[1]).toContain(request.protocol);
    expect(lines[1]).toContain("a@test.local");
    expect(lines[1]).toContain('"Motivo, com vírgula e ""aspas""."');
    expect(cancellationQueueToCsv(queue.items, true)).toContain("Exportação limitada");

    expect(transfersToCsv((await searchTransfers(db, a, { exportAll: true })).items, false).slice(1).split("\r\n")[0]).toContain("Ingresso");
    expect(changeWindowsToCsv((await listOpenChangeWindows(db, a, { exportAll: true })).items, false).slice(1).split("\r\n")[0]).toContain("Reembolso integral até");
  });
});
