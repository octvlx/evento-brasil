// L10b (Decreto 13.108/2026): o ingresso (página e PDF) identifica o organizador
// responsável — razão social e CNPJ da PJ, ou só o nome da PF (nunca o CPF).
import { beforeEach, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { encryptPII } from "@/server/crypto";
import { loadPdfTickets } from "@/server/services/notifications";
import { organizerIdentities, organizerIdentity, organizerIdentityLine } from "@/server/tickets/organizer-identity";
import { renderTicketsPdf } from "@/server/tickets/pdf";
import { buyAndPay, db, makeEvent, makeOrg, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function verify(organizationId: string, submittedById: string, v: { legalType: "COMPANY" | "INDIVIDUAL"; legalName: string; document: string; status?: "APPROVED" | "SUBMITTED" | "REJECTED" }) {
  return db.organizerVerification.create({
    data: {
      organizationId,
      submittedById,
      legalType: v.legalType,
      legalName: v.legalName,
      documentType: v.legalType === "COMPANY" ? "CNPJ" : "CPF",
      documentEncrypted: encryptPII(v.document),
      documentLast4: v.document.slice(-4),
      status: v.status ?? "APPROVED",
    },
  });
}

describe("L10b — identificação do organizador no ingresso", () => {
  it("PJ: razão social e CNPJ formatado da verificação aprovada mais recente", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    await verify(org.id, owner.id, { legalType: "COMPANY", legalName: "Antiga Produções Ltda", document: "11222333000181" });
    await new Promise((r) => setTimeout(r, 5));
    await verify(org.id, owner.id, { legalType: "COMPANY", legalName: "Show Produções Ltda", document: "11444777000161" });
    // Pendente/recusada não vale.
    await verify(org.id, owner.id, { legalType: "COMPANY", legalName: "Não Aprovada SA", document: "11222333000181", status: "SUBMITTED" });

    const id = await organizerIdentity(db, org.id);
    expect(id).toEqual({ name: "Show Produções Ltda", cnpj: "11.444.777/0001-61" });
    expect(organizerIdentityLine(id!)).toBe("Show Produções Ltda · CNPJ 11.444.777/0001-61");
  });

  it("PF: só o nome, nunca o CPF; sem verificação aprovada: nome público", async () => {
    const owner = await makeUser();
    const pf = await makeOrg(owner);
    await db.organization.update({ where: { id: pf.id }, data: { legalType: "INDIVIDUAL" } });
    await verify(pf.id, owner.id, { legalType: "INDIVIDUAL", legalName: "Maria da Silva", document: "52998224725" });
    const none = await makeOrg(owner);

    const ids = await organizerIdentities(db, [pf.id, none.id, pf.id]);
    expect(ids.get(pf.id)).toEqual({ name: "Maria da Silva", cnpj: null });
    expect(organizerIdentityLine(ids.get(pf.id)!)).not.toMatch(/\d/);
    expect(ids.get(none.id)).toEqual({ name: none.name, cnpj: null });
  });

  it("documento ilegível não derruba o ingresso: sai a razão social sem CNPJ", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    const v = await verify(org.id, owner.id, { legalType: "COMPANY", legalName: "Show Produções Ltda", document: "11444777000161" });
    await db.organizerVerification.update({ where: { id: v.id }, data: { documentEncrypted: "v1.AAAA.BBBB.CCCC" } });
    expect(await organizerIdentity(db, org.id)).toEqual({ name: "Show Produções Ltda", cnpj: null });
  });

  it("o PDF do ingresso renderiza com o organizador responsável (uma página A5 por ingresso)", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    await verify(org.id, owner.id, { legalType: "COMPANY", legalName: "Show Produções Ltda", document: "11444777000161" });
    const event = await makeEvent(org);
    const buyer = await makeUser();
    const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 2 }]);
    const tickets = await loadPdfTickets(db, { orderId: order.id, holderUserId: buyer.id });
    const identity = (await organizerIdentity(db, org.id))!;
    const bytes = await renderTicketsPdf(tickets.map((t) => ({ ...t, organizerIdentity: identity })));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 420, height: 595 });
  });
});
