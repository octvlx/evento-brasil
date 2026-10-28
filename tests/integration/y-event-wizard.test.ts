// Assistente de criação de evento: rascunho na etapa 1, gravação por etapa,
// progresso, idempotência, permissões e bloqueio de publicação incompleta.
import { beforeEach, describe, expect, it } from "vitest";
import { recordWizardVisit, saveEventWizardStep, startEventDraft } from "@/server/services/event-wizard";
import { getWizardProgress } from "@/server/services/event-wizard-progress";
import { submitEventForPublication, upsertTicketType } from "@/server/services/events";
import { db, makeCategory, makeCity, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const DAY = 86_400_000;
/** "AAAA-MM-DDTHH:mm" no fuso de São Paulo (UTC−3). */
const local = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 16);

async function setup(extraRole?: "CHECKIN_STAFF" | "EVENT_MANAGER") {
  const [owner, other, city, category] = await Promise.all([makeUser(), makeUser(), makeCity(), makeCategory()]);
  const org = await makeOrg(owner, { extraMembers: extraRole ? [{ userId: other.id, role: extraRole }] : [] });
  return { owner, other, org, city, category };
}

function step2(cityId: string, startsAt = new Date(Date.now() + 20 * DAY)) {
  return {
    timezone: "America/Sao_Paulo",
    startsAtLocal: local(startsAt),
    endsAtLocal: local(new Date(startsAt.getTime() + 4 * 3_600_000)),
    locationType: "VENUE",
    venueMode: "new",
    newVenue: { name: "Casa do Teste", street: "Rua A", number: "10", complement: "Fundos", district: "Centro", postalCode: "01001-000", cityId },
  };
}

describe("Y — assistente de criação de evento", () => {
  it("cria o rascunho na etapa 1 e repetir a mesma chave devolve o mesmo evento (sem duplicar)", async () => {
    const { owner, org, category } = await setup();
    const input = { draftKey: "chave-de-teste-123", title: "Festival Guiado", categoryId: category.id };
    const [a, b, c] = await Promise.all([startEventDraft(db, owner, org.id, input), startEventDraft(db, owner, org.id, input), startEventDraft(db, owner, org.id, input)]);
    expect(new Set([a.event.id, b.event.id, c.event.id]).size).toBe(1);
    expect([a, b, c].filter((r) => r.created)).toHaveLength(1);
    expect(await db.event.count({ where: { organizationId: org.id } })).toBe(1);
    expect(a.event).toMatchObject({ status: "DRAFT", title: "Festival Guiado", description: "" });
    expect(await getWizardProgress(db, a.event.id)).toMatchObject({ tracked: true, completed: [], lastStep: 1 });

    // Outra chave (outro formulário) cria outro rascunho.
    const d = await startEventDraft(db, owner, org.id, { ...input, draftKey: "outra-chave-456" });
    expect(d.event.id).not.toBe(a.event.id);
  });

  it("valida cada etapa no servidor com mensagens em pt-BR", async () => {
    const { owner, org, city, category } = await setup();
    await expect(startEventDraft(db, owner, org.id, { draftKey: "chave-curta-ok", title: "", categoryId: category.id })).rejects.toThrow("Informe o título");
    const { event } = await startEventDraft(db, owner, org.id, { draftKey: "chave-valida-1", title: "Evento", categoryId: category.id });
    const s2 = step2(city.id);
    await expect(saveEventWizardStep(db, owner, event.id, 2, { ...s2, endsAtLocal: s2.startsAtLocal }, { complete: true })).rejects.toThrow("O término deve ser depois do início");
    await expect(saveEventWizardStep(db, owner, event.id, 2, { ...s2, locationType: "ONLINE", onlineUrl: "http://inseguro" }, { complete: true })).rejects.toThrow("Use um link https://");
    // Etapa 3 exige a 2 concluída.
    await expect(
      saveEventWizardStep(db, owner, event.id, 3, { capacity: 10, salesStartLocal: local(new Date()), salesEndLocal: s2.startsAtLocal }, { complete: false }),
    ).rejects.toThrow("Conclua a etapa 2");
    await expect(saveEventWizardStep(db, owner, event.id, 4, { description: "curta", ageRestriction: 0 }, { complete: true })).rejects.toThrow("mínimo 20 caracteres");
    expect((await getWizardProgress(db, event.id)).completed).toEqual([]);
  });

  it("percorre as 5 etapas, grava os dados reais, não duplica o local no autosave e publica no fim", async () => {
    const { owner, org, city, category } = await setup();
    const { event } = await startEventDraft(db, owner, org.id, { draftKey: "fluxo-completo-1", title: "Show Guiado", categoryId: category.id });
    await saveEventWizardStep(db, owner, event.id, 1, { title: "Show Guiado", categoryId: category.id, summary: "Uma noite" }, { complete: true });

    const s2 = step2(city.id);
    // Autosave repetido do mesmo "novo local": atualiza o local criado para o evento.
    await saveEventWizardStep(db, owner, event.id, 2, s2, { complete: false });
    await saveEventWizardStep(db, owner, event.id, 2, { ...s2, newVenue: { ...s2.newVenue, number: "20" } }, { complete: true });
    const venues = await db.venue.findMany({ where: { organizationId: org.id } });
    expect(venues).toHaveLength(1);
    expect(venues[0]).toMatchObject({ addressLine: "Rua A, 20 – Fundos", postalCode: "01001000" });
    let row = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.slug).toBe("show-guiado-sao-paulo");
    expect(row.venueId).toBe(venues[0].id);
    // Período de vendas provisório acompanha a data do evento.
    expect(row.salesEndAt.toISOString()).toBe(row.startsAt.toISOString());

    // Etapa 3 só conclui com ao menos um tipo de ingresso.
    const s3 = { capacity: "250", halfPriceQuotaPercent: "40", salesStartLocal: local(new Date()), salesEndLocal: s2.startsAtLocal, endsAtLocal: s2.endsAtLocal };
    await expect(saveEventWizardStep(db, owner, event.id, 3, s3, { complete: true })).rejects.toThrow("ao menos um tipo de ingresso");
    await upsertTicketType(db, owner, event.id, { name: "Inteira", kind: "GENERAL", priceCents: 8000, quantityTotal: 200 });
    await saveEventWizardStep(db, owner, event.id, 3, s3, { complete: true });
    await expect(saveEventWizardStep(db, owner, event.id, 3, { ...s3, salesEndLocal: local(new Date(Date.now() + 40 * DAY)) }, { complete: true })).rejects.toThrow(
      "As vendas devem terminar até o fim do evento",
    );

    // Ainda incompleto: publicação recusada.
    await expect(submitEventForPublication(db, owner, event.id)).rejects.toThrow("Conclua todas as etapas");

    await saveEventWizardStep(db, owner, event.id, 4, { description: "Descrição completa do evento guiado.", ageRestriction: "16", coverImageUrl: "" }, { complete: true });
    await saveEventWizardStep(db, owner, event.id, 5, { refundPolicy: "Reembolso conforme os prazos.", refundWindowDays: "10", refundMinHoursBeforeEvent: "24" }, { complete: true });
    expect((await getWizardProgress(db, event.id)).completed).toEqual([1, 2, 3, 4, 5]);

    row = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(row).toMatchObject({ capacity: 250, halfPriceQuotaBps: 4000, ageRestriction: 16, refundWindowDays: 10, refundMinHoursBeforeEvent: 24, summary: "Uma noite" });

    const published = await submitEventForPublication(db, owner, event.id);
    expect(published.status).toBe("PENDING_REVIEW");
    // Idempotente: clique repetido devolve o mesmo estado sem erro nem auditoria duplicada.
    const again = await submitEventForPublication(db, owner, event.id);
    expect(again.status).toBe("PENDING_REVIEW");
    expect(await db.auditLog.count({ where: { entityId: event.id, action: "event.submitted" } })).toBe(1);

    // Depois de enviado, o assistente não grava mais (edição pela página de gestão).
    await expect(saveEventWizardStep(db, owner, event.id, 1, { title: "Outro", categoryId: category.id }, { complete: false })).rejects.toThrow("já foi enviado");
  });

  it("registra a última etapa acessada sem regravar quando nada muda", async () => {
    const { owner, org, category } = await setup();
    const { event } = await startEventDraft(db, owner, org.id, { draftKey: "visita-etapas-1", title: "Visitas", categoryId: category.id });
    await recordWizardVisit(db, owner, event.id, 2);
    await recordWizardVisit(db, owner, event.id, 2);
    expect((await getWizardProgress(db, event.id)).lastStep).toBe(2);
    expect(await db.auditLog.count({ where: { entityId: event.id, action: "event.wizard_progress" } })).toBe(2);
  });

  it("exige event:write: cliente de fora, equipe de portaria e outra organização são recusados", async () => {
    const { owner, other, org, category } = await setup("CHECKIN_STAFF");
    const stranger = await makeUser();
    const input = { draftKey: "permissoes-1234", title: "Privado", categoryId: category.id };
    await expect(startEventDraft(db, stranger, org.id, input)).rejects.toThrow("permissão");
    await expect(startEventDraft(db, other, org.id, input)).rejects.toThrow("permissão");
    const { event } = await startEventDraft(db, owner, org.id, input);
    await expect(saveEventWizardStep(db, stranger, event.id, 1, { title: "Invasão", categoryId: category.id }, { complete: true })).rejects.toThrow("permissão");
    await expect(saveEventWizardStep(db, other, event.id, 1, { title: "Invasão", categoryId: category.id }, { complete: true })).rejects.toThrow("permissão");
    await expect(recordWizardVisit(db, stranger, event.id, 3)).rejects.toThrow("permissão");
    // O rascunho de outra pessoa com a mesma chave não é "recuperado" por quem não tem acesso.
    const otherOwner = await makeUser();
    const otherOrg = await makeOrg(otherOwner);
    const theirs = await startEventDraft(db, otherOwner, otherOrg.id, input);
    expect(theirs.event.id).not.toBe(event.id);
    expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).title).toBe("Privado");
  });

  it("eventos criados fora do assistente continuam publicáveis normalmente", async () => {
    const { owner, org } = await setup();
    const legacy = await makeEvent(org, { status: "DRAFT" });
    expect(await getWizardProgress(db, legacy.id)).toMatchObject({ tracked: false });
    expect((await submitEventForPublication(db, owner, legacy.id)).status).toBe("PENDING_REVIEW");
  });
});
