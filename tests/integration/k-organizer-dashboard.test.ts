// Painel do organizador e criação de organizações: escopo por organização,
// permissões por papel e limite de cadastros pendentes.
import { beforeEach, describe, expect, it } from "vitest";
import { organizerDashboard } from "@/server/services/reports";
import { listMyOrganizations, MAX_PENDING_APPLICATIONS, resubmitOrganizerApplication, submitOrganizerApplication } from "@/server/services/organizers";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const application = (name: string) => ({
  name,
  legalType: "COMPANY" as const,
  legalName: `${name} LTDA`,
  document: "11.222.333/0001-81",
  contactEmail: "contato@example.com",
});

describe("painel do organizador", () => {
  it("mostra só dados da própria organização, com vendas, check-ins e receita por evento", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const other = await makeOrg(await makeUser());
    const mine = await makeEvent(org, { tickets: [{ priceCents: 10000, quantityTotal: 50 }], startsInDays: 3 });
    const foreign = await makeEvent(other, { startsInDays: 2 });
    await buyAndPay(await makeUser(), mine.id, [{ ticketTypeId: mine.ticketTypes[0].id, quantity: 2 }]);
    await buyAndPay(await makeUser(), foreign.id, [{ ticketTypeId: foreign.ticketTypes[0].id, quantity: 1 }]);

    const dash = await organizerDashboard(db, owner, org.id);
    expect(dash.upcomingEvents.map((e) => e.id)).toEqual([mine.id]);
    expect(dash.upcomingEvents[0]).toMatchObject({ sold: 2, checkedIn: 0, capacity: 1000 });
    expect(dash.recentOrders?.map((o) => o.event.title)).toEqual([mine.title]);
    expect(dash.eventPerformance).toEqual([expect.objectContaining({ id: mine.id, sold: 2, grossCents: 20000, refundCents: 0 })]);
    // Evento publicado em menos de 7 dias e sem equipe de check-in gera pendência.
    expect(dash.alerts.some((a) => a.text.includes("equipe de check-in"))).toBe(true);
  });

  it("esconde dados financeiros de quem não tem finance:read e recusa quem não é membro", async () => {
    const owner = await makeUser();
    const manager = await makeUser();
    const finance = await makeUser();
    const org = await makeOrg(owner, { extraMembers: [{ userId: manager.id, role: "EVENT_MANAGER" }, { userId: finance.id, role: "FINANCE" }] });
    await makeEvent(org);

    const asManager = await organizerDashboard(db, manager, org.id);
    expect(asManager.recentOrders).toBeNull();
    expect(asManager.eventPerformance).toBeNull();
    expect(asManager.upcomingEvents).toHaveLength(1);

    const asFinance = await organizerDashboard(db, finance, org.id);
    expect(asFinance.recentOrders).toEqual([]);

    await expect(organizerDashboard(db, await makeUser(), org.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const staff = await makeUser();
    await db.organizationMember.create({ data: { organizationId: org.id, userId: staff.id, role: "CHECKIN_STAFF" } });
    await expect(organizerDashboard(db, staff, org.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lista pendências acionáveis: rascunho sem ingressos e convites pendentes", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const draft = await makeEvent(org, { status: "DRAFT", tickets: [] });
    await db.organizationInvitation.create({
      data: { organizationId: org.id, email: "x@y.com", role: "FINANCE", tokenHash: "h1", invitedById: owner.id, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const dash = await organizerDashboard(db, owner, org.id);
    expect(dash.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("ainda não tem ingressos"), href: `/organizador/eventos/${draft.id}/editar` }),
        expect.objectContaining({ text: expect.stringContaining("1 convite(s)") }),
      ]),
    );
  });
});

describe("criação de organizações", () => {
  it("permite criar uma segunda organização; o criador vira OWNER e a lista mostra só as dele", async () => {
    const user = await makeUser();
    const first = await submitOrganizerApplication(db, user, application("Primeira"));
    const second = await submitOrganizerApplication(db, user, application("Segunda"));
    expect(first.id).not.toBe(second.id);
    expect(second.status).toBe("PENDING_REVIEW");
    await makeOrg(await makeUser()); // de outra pessoa

    const mine = await listMyOrganizations(db, user);
    expect(mine.map((o) => o.name).sort()).toEqual(["Primeira", "Segunda"]);
    expect(mine.every((o) => o.role === "OWNER")).toBe(true);
  });

  it(`limita a ${MAX_PENDING_APPLICATIONS} cadastros aguardando análise por usuário`, async () => {
    const user = await makeUser();
    for (let i = 0; i < MAX_PENDING_APPLICATIONS; i++) await submitOrganizerApplication(db, user, application(`Org ${i}`));
    await expect(submitOrganizerApplication(db, user, application("Mais uma"))).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    // Aprovada não conta para o limite.
    const first = await db.organization.findFirstOrThrow({ where: { name: "Org 0" } });
    await db.organization.update({ where: { id: first.id }, data: { status: "APPROVED" } });
    await expect(submitOrganizerApplication(db, user, application("Agora pode"))).resolves.toMatchObject({ name: "Agora pode" });
  });

  it("reenvio só funciona na própria organização recusada", async () => {
    const owner = await makeUser();
    const org = await submitOrganizerApplication(db, owner, application("Recusada"));
    await db.organization.update({ where: { id: org.id }, data: { status: "REJECTED", statusReason: "Documento ilegível" } });
    await expect(resubmitOrganizerApplication(db, await makeUser(), org.id, application("Invasor"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const again = await resubmitOrganizerApplication(db, owner, org.id, application("Recusada Corrigida"));
    expect(again).toMatchObject({ status: "PENDING_REVIEW", name: "Recusada Corrigida", statusReason: null });
  });
});
