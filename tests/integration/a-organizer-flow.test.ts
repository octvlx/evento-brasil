// Fluxo A: cadastro do organizador → aprovação → criação → publicação.
import { beforeEach, describe, expect, it } from "vitest";
import { registerUser, authenticate } from "@/server/services/users";
import { reviewOrganization, submitOrganizerApplication, setAutoPublish } from "@/server/services/organizers";
import { createEvent, moderateEvent, submitEventForPublication, upsertTicketType } from "@/server/services/events";
import { searchEvents } from "@/server/services/catalog";
import { decryptPII } from "@/server/crypto";
import { db, makeCategory, makeCity, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

function eventInput(categoryId: string, cityId: string) {
  return {
    title: "Show de Teste",
    description: "Um show de teste com descrição longa o suficiente.",
    categoryId,
    locationType: "VENUE" as const,
    newVenue: { name: "Espaço Teste", addressLine: "Rua Exemplo, 100", cityId },
    timezone: "America/Sao_Paulo" as const,
    startsAtLocal: "2030-05-10T20:00",
    endsAtLocal: "2030-05-10T23:00",
    salesStartLocal: "2026-01-01T00:00",
    salesEndLocal: "2030-05-10T20:00",
    ageRestriction: 16,
    capacity: 200,
    refundPolicy: "Reembolso em até 7 dias após a compra.",
  };
}

describe("A — organizador: cadastro → aprovação → evento → publicação", () => {
  it("percorre o fluxo completo com moderação", async () => {
    const user = await registerUser(db, { name: "Ana Organiza", email: "Ana@Example.com", password: "senha-forte-1", acceptTerms: true, acceptPrivacy: true });
    expect(user.email).toBe("ana@example.com");
    expect(await authenticate(db, "ana@example.com", "senha-forte-1", { production: false })).not.toBeNull();
    expect(await authenticate(db, "ana@example.com", "errada", { production: false })).toBeNull();

    const org = await submitOrganizerApplication(db, user, {
      name: "Ana Eventos",
      legalType: "INDIVIDUAL",
      legalName: "Ana Organiza",
      document: "529.982.247-25",
      contactEmail: "ana@example.com",
    });
    expect(org.status).toBe("PENDING_REVIEW");
    const verification = await db.organizerVerification.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(verification.documentEncrypted).not.toContain("52998224725");
    expect(decryptPII(verification.documentEncrypted)).toBe("52998224725");
    expect(verification.documentLast4).toBe("4725");

    const [category, city] = await Promise.all([makeCategory(), makeCity()]);
    const event = await createEvent(db, user, org.id, eventInput(category.id, city.id));
    expect(event.status).toBe("DRAFT");
    expect(event.startsAt.toISOString()).toBe("2030-05-10T23:00:00.000Z");
    await upsertTicketType(db, user, event.id, { name: "Inteira", kind: "GENERAL", priceCents: 5000, quantityTotal: 100 });

    // Sem aprovação, não publica.
    await expect(submitEventForPublication(db, user, event.id)).rejects.toThrow(/aprovada/);

    const stranger = await makeUser();
    await expect(reviewOrganization(db, stranger, org.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = await makeUser({ admin: true });
    await expect(reviewOrganization(db, admin, org.id, "REJECT")).rejects.toThrow(/motivo/);
    expect((await reviewOrganization(db, admin, org.id, "APPROVE")).status).toBe("APPROVED");

    const submitted = await submitEventForPublication(db, user, event.id);
    expect(submitted.status).toBe("PENDING_REVIEW");
    expect((await searchEvents(db, {})).total).toBe(0);

    const published = await moderateEvent(db, admin, event.id, "APPROVE");
    expect(published.status).toBe("PUBLISHED");
    const results = await searchEvents(db, { q: "show de teste" });
    expect(results.events.map((e) => e.id)).toEqual([event.id]);
    expect(results.events[0].minPriceCents).toBe(5000);

    const logs = await db.auditLog.findMany({ where: { organizationId: org.id }, select: { action: true } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["organization.submitted", "organization.approved", "event.created", "event.approved"]));
  });

  it("publica direto quando a organização tem publicação automática", async () => {
    const user = await makeUser();
    const admin = await makeUser({ admin: true });
    const org = await submitOrganizerApplication(db, user, {
      name: "Auto Org",
      legalType: "COMPANY",
      legalName: "Auto Org LTDA",
      document: "11.222.333/0001-81",
      contactEmail: "auto@example.com",
    });
    await reviewOrganization(db, admin, org.id, "APPROVE");
    await setAutoPublish(db, admin, org.id, true);
    const [category, city] = await Promise.all([makeCategory(), makeCity()]);
    const event = await createEvent(db, user, org.id, eventInput(category.id, city.id));
    await upsertTicketType(db, user, event.id, { name: "Grátis", kind: "FREE", priceCents: 0, quantityTotal: 10 });
    expect((await submitEventForPublication(db, user, event.id)).status).toBe("PUBLISHED");
  });

  it("recusa preço de ingresso menor que a taxa da plataforma quando ela sai do repasse", async () => {
    const user = await makeUser();
    const org = await makeOrg(user);
    const [category, city] = await Promise.all([makeCategory(), makeCity()]);
    const event = await createEvent(db, user, org.id, eventInput(category.id, city.id));
    // Taxa da plataforma: 7% + R$ 1,00 por ingresso, descontada do organizador.
    await db.commissionRule.updateMany({ where: { scope: "PLATFORM" }, data: { fixedCentsPerTicket: 100, bearer: "ORGANIZER" } });

    await expect(upsertTicketType(db, user, event.id, { name: "Barato", kind: "GENERAL", priceCents: 50, quantityTotal: 10 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await db.ticketType.count({ where: { eventId: event.id } })).toBe(0);
    // Gratuito e preço que cobre a taxa continuam válidos.
    await upsertTicketType(db, user, event.id, { name: "Grátis", kind: "FREE", priceCents: 0, quantityTotal: 10 });
    const ok = await upsertTicketType(db, user, event.id, { name: "Inteira", kind: "GENERAL", priceCents: 500, quantityTotal: 10 });
    // Baixar o preço de um tipo existente para baixo da taxa também é recusado.
    await expect(upsertTicketType(db, user, event.id, { id: ok.id, name: "Inteira", kind: "GENERAL", priceCents: 99, quantityTotal: 10 })).rejects.toMatchObject({
      code: "VALIDATION",
    });

    // Com a taxa cobrada do comprador, não há repasse negativo: o preço baixo é aceito.
    await db.commissionRule.updateMany({ where: { scope: "PLATFORM" }, data: { bearer: "BUYER" } });
    await upsertTicketType(db, user, event.id, { name: "Barato", kind: "GENERAL", priceCents: 50, quantityTotal: 10 });
  });

  it("rejeita CPF inválido e e-mail duplicado", async () => {
    const user = await makeUser();
    await expect(
      submitOrganizerApplication(db, user, { name: "X", legalType: "INDIVIDUAL", legalName: "X Y", document: "123.456.789-00", contactEmail: "x@y.com" }),
    ).rejects.toThrow();
    await registerUser(db, { name: "Dup", email: "dup@example.com", password: "12345678", acceptTerms: true, acceptPrivacy: true });
    await expect(registerUser(db, { name: "Dup", email: "DUP@example.com", password: "12345678", acceptTerms: true, acceptPrivacy: true })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
