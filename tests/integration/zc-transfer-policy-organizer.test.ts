import { beforeEach, describe, expect, it } from "vitest";
import { eventInputSchema, type EventInput } from "@/features/schemas";
import { step5Schema, stepPayload, type WizardValues } from "@/features/organizer/wizard-steps";
import { createEvent, updateEvent } from "@/server/services/events";
import { saveEventWizardStep, startEventDraft } from "@/server/services/event-wizard";
import { buy, buyAndPay, db, makeCategory, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);
const HOUR = 3_600_000;
const local = (date: Date) => new Date(date.getTime() - 3 * HOUR).toISOString().slice(0, 16);

async function setup(policy: Record<string, unknown> = {}) {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const category = await makeCategory();
  const start = new Date(Date.now() + 30 * 24 * HOUR);
  const input: EventInput = {
    title: "Show com transferência configurável", description: "Descrição do evento com mais de vinte caracteres.",
    categoryId: category.id, locationType: "ONLINE" as const, onlineUrl: "https://example.com/show",
    timezone: "America/Sao_Paulo" as const, startsAtLocal: local(start), endsAtLocal: local(new Date(start.getTime() + 4 * HOUR)),
    salesStartLocal: local(new Date(Date.now() - 24 * HOUR)), salesEndLocal: local(start),
    ageRestriction: 0, capacity: 100, refundPolicy: "Reembolso integral conforme os prazos informados.", ...policy,
  };
  const event = await createEvent(db, owner, org.id, input);
  return { owner, org, category, input, event };
}

async function commitTicket(s: Awaited<ReturnType<typeof setup>>, paid: boolean) {
  const buyer = await makeUser();
  const ticketType = await db.ticketType.create({ data: { eventId: s.event.id, name: "Inteira", kind: "GENERAL", priceCents: 5000, quantityTotal: 20 } });
  await db.event.update({ where: { id: s.event.id }, data: { status: "PUBLISHED" } });
  const items = [{ ticketTypeId: ticketType.id, quantity: 1 }];
  if (paid) await buyAndPay(buyer, s.event.id, items);
  else await buy(buyer, s.event.id, items);
}

describe("política de transferência — configurações do organizador", () => {
  it("persiste padrões e valores configurados, inclusive prazo zero e devolução", async () => {
    const s = await setup();
    expect(s.event).toMatchObject({ transferDeadlineHours: 24, transferMaxTransfers: 1, transferAllowReturn: false });
    const updated = await updateEvent(db, s.owner, s.event.id, { ...s.input, transferDeadlineHours: 0, transferMaxTransfers: 3, transferAllowReturn: true });
    expect(updated).toMatchObject({ transferDeadlineHours: 0, transferMaxTransfers: 3, transferAllowReturn: true });
    const fresh = await createEvent(db, s.owner, s.org.id, { ...s.input, transferDeadlineHours: 72, transferMaxTransfers: 2, transferAllowReturn: true });
    expect(fresh).toMatchObject({ transferDeadlineHours: 72, transferMaxTransfers: 2, transferAllowReturn: true });
  });

  it("valida limites e exige pelo menos duas transferências para devolução em ambos os schemas", async () => {
    const s = await setup();
    for (const invalid of [{ transferDeadlineHours: -1 }, { transferDeadlineHours: 8761 }, { transferDeadlineHours: 1.5 }, { transferMaxTransfers: 0 }, { transferMaxTransfers: 11 }, { transferMaxTransfers: 1.5 }, { transferAllowReturn: "false" }, { transferAllowReturn: true, transferMaxTransfers: 1 }]) {
      expect(eventInputSchema.safeParse({ ...s.input, ...invalid }).success).toBe(false);
      expect(step5Schema.safeParse({ refundPolicy: s.input.refundPolicy, ...invalid }).success).toBe(false);
      await expect(updateEvent(db, s.owner, s.event.id, { ...s.input, ...invalid } as EventInput)).rejects.toThrow();
    }
    await expect(updateEvent(db, s.owner, s.event.id, { ...s.input, transferAllowReturn: true })).rejects.toThrow(/ao menos 2 transferências/);
  });

  it("recusa escrita de outra organização e de papel sem event:write", async () => {
    const s = await setup();
    const outsider = await makeUser();
    const finance = await makeUser();
    await db.organizationMember.create({ data: { organizationId: s.org.id, userId: finance.id, role: "FINANCE" } });
    for (const actor of [outsider, finance]) {
      await expect(updateEvent(db, actor, s.event.id, { ...s.input, transferDeadlineHours: 0 })).rejects.toThrow();
      await expect(createEvent(db, actor, s.org.id, s.input)).rejects.toThrow();
    }
    expect((await db.event.findUniqueOrThrow({ where: { id: s.event.id } })).transferDeadlineHours).toBe(24);
  });

  it.each([false, true])("protege direitos com ingressos comprometidos (pago=%s) e aceita ampliação sem janela artificial", async (paid) => {
    const s = await setup({ transferDeadlineHours: 12, transferMaxTransfers: 3, transferAllowReturn: true });
    await commitTicket(s, paid);
    for (const stricter of [{ transferDeadlineHours: 24 }, { transferMaxTransfers: 2 }, { transferAllowReturn: false }]) {
      await expect(updateEvent(db, s.owner, s.event.id, { ...s.input, ...stricter })).rejects.toThrow(/só pode ficar mais favorável/);
    }
    const better = await updateEvent(db, s.owner, s.event.id, { ...s.input, transferDeadlineHours: 0, transferMaxTransfers: 4 });
    expect(better).toMatchObject({ transferDeadlineHours: 0, transferMaxTransfers: 4, transferAllowReturn: true });
    expect(await db.eventChange.count({ where: { eventId: s.event.id } })).toBe(0);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: s.event.id, action: "event.updated" }, orderBy: { createdAt: "desc" } });
    expect(audit.metadata).toMatchObject({ transferPolicy: {
      before: { transferDeadlineHours: 12, transferMaxTransfers: 3, transferAllowReturn: true },
      after: { transferDeadlineHours: 0, transferMaxTransfers: 4, transferAllowReturn: true },
    } });
  });

  it("permite habilitar devolução com vendas e preserva customização quando cliente antigo omite campos", async () => {
    const s = await setup({ transferDeadlineHours: 12, transferMaxTransfers: 3 });
    await commitTicket(s, true);
    const { transferDeadlineHours: _deadline, transferMaxTransfers: _max, ...legacyInput } = s.input;
    void _deadline; void _max;
    const unchanged = await updateEvent(db, s.owner, s.event.id, legacyInput);
    expect(unchanged).toMatchObject({ transferDeadlineHours: 12, transferMaxTransfers: 3, transferAllowReturn: false });
    const enabled = await updateEvent(db, s.owner, s.event.id, { ...legacyInput, transferAllowReturn: true });
    expect(enabled).toMatchObject({ transferDeadlineHours: 12, transferMaxTransfers: 3, transferAllowReturn: true });
  });

  it("salva, retoma e audita a política na etapa 5 sem perder o booleano na serialização", async () => {
    const owner = await makeUser(); const org = await makeOrg(owner); const category = await makeCategory();
    const { event } = await startEventDraft(db, owner, org.id, { draftKey: "transfer-policy-draft", title: "Evento configurado", categoryId: category.id });
    const values = { refundPolicy: "Política de reembolso de teste.", refundWindowDays: "7", refundMinHoursBeforeEvent: "48", transferDeadlineHours: "0", transferMaxTransfers: "2", transferAllowReturn: true };
    const payload = stepPayload(5, values as WizardValues);
    expect(payload.transferAllowReturn).toBe(true);
    const saved = await saveEventWizardStep(db, owner, event.id, 5, payload, { complete: true });
    expect(saved.event).toMatchObject({ transferDeadlineHours: 0, transferMaxTransfers: 2, transferAllowReturn: true });
    const legacy = await saveEventWizardStep(db, owner, event.id, 5, { refundPolicy: values.refundPolicy }, { complete: false });
    expect(legacy.event).toMatchObject({ transferDeadlineHours: 0, transferMaxTransfers: 2, transferAllowReturn: true });
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: event.id, action: "event.updated" }, orderBy: { createdAt: "desc" } });
    expect(audit.metadata).toMatchObject({ wizardStep: 5, transferPolicy: { after: { transferDeadlineHours: 0, transferMaxTransfers: 2, transferAllowReturn: true } } });
    await expect(saveEventWizardStep(db, owner, event.id, 5, { ...payload, transferMaxTransfers: 1 }, { complete: false })).rejects.toThrow(/ao menos 2 transferências/);
  });
});
