// Fase 4 (paginas-publicas): lógica de servidor por trás das telas do comprador —
// aceite/recusa por id em "Meus ingressos" e identificação do organizador (L10b).
import { beforeEach, describe, expect, it } from "vitest";
import { getPublicEvent, organizerIdentification } from "@/server/services/catalog";
import { acceptTransfer, declineTransfer, listMyTransfers, requestTransfer } from "@/server/services/transfers";
import { buyAndPay, db, makeEvent, makeOrg, makeVerifiedUser as makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

async function setup() {
  const owner = await makeUser();
  const org = await makeOrg(owner);
  const event = await makeEvent(org);
  const buyer = await makeUser();
  const recipient = await makeUser();
  const { order } = await buyAndPay(buyer, event.id, [{ ticketTypeId: event.ticketTypes[0].id, quantity: 1 }]);
  const ticket = await db.issuedTicket.findFirstOrThrow({ where: { orderId: order.id } });
  const { transferId } = await requestTransfer(db, buyer, ticket.id, { toEmail: recipient.email, toName: "Quem Recebe" });
  return { owner, org, event, buyer, recipient, ticket, transferId };
}

describe("Fase 4 — transferência respondida em Meus ingressos (por id)", () => {
  it("o destinatário aceita pelo id listado: novo titular e novo QR", async () => {
    const { buyer, recipient, ticket, transferId } = await setup();
    const listed = await listMyTransfers(db, recipient);
    expect(listed.received.map((t) => t.id)).toEqual([transferId]);

    const res = await acceptTransfer(db, recipient, { transferId });
    expect(res.ticketCode).toBe(ticket.code);
    const after = await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.holderUserId).toBe(recipient.id);
    expect(after.validationToken).not.toBe(ticket.validationToken);

    // Para quem enviou, vira histórico ("Transferidos por você").
    const sent = (await listMyTransfers(db, buyer)).sent;
    expect(sent).toMatchObject([{ id: transferId, status: "ACCEPTED" }]);
  });

  it("por id valem as mesmas regras: outra conta e o próprio remetente não respondem", async () => {
    const { buyer, owner, transferId } = await setup();
    await expect(acceptTransfer(db, owner, { transferId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(declineTransfer(db, owner, { transferId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(acceptTransfer(db, buyer, { transferId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(acceptTransfer(db, owner, { transferId: "nao-existe" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } })).status).toBe("PENDING");
  });

  it("recusa por id: o ingresso fica com quem enviou e não dá para aceitar depois", async () => {
    const { buyer, recipient, ticket, transferId } = await setup();
    await declineTransfer(db, recipient, { transferId });
    expect(await db.ticketTransfer.findUniqueOrThrow({ where: { id: transferId } })).toMatchObject({ status: "CANCELLED", decidedById: recipient.id });
    expect((await db.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } })).holderUserId).toBe(buyer.id);
    await expect(acceptTransfer(db, recipient, { transferId })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("Fase 4 — identificação do organizador (L10b)", () => {
  async function verification(organizationId: string, submittedById: string, data: { legalType: "COMPANY" | "INDIVIDUAL"; status: "SUBMITTED" | "APPROVED" | "REJECTED"; legalName: string; last4: string }) {
    return db.organizerVerification.create({
      data: {
        organizationId,
        submittedById,
        legalType: data.legalType,
        legalName: data.legalName,
        documentType: data.legalType === "COMPANY" ? "CNPJ" : "CPF",
        documentEncrypted: "cifrado",
        documentLast4: data.last4,
        status: data.status,
      },
    });
  }

  it("empresa: razão social e final do CNPJ da verificação aprovada; no getPublicEvent", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    await verification(org.id, owner.id, { legalType: "COMPANY", status: "APPROVED", legalName: "Eventos Teste LTDA", last4: "0181" });
    expect(await organizerIdentification(db, org.id)).toEqual({ legalType: "COMPANY", legalName: "Eventos Teste LTDA", cnpjLast4: "0181" });
    const event = await makeEvent(org);
    expect((await getPublicEvent(db, event.slug))?.organizer).toEqual({ legalType: "COMPANY", legalName: "Eventos Teste LTDA", cnpjLast4: "0181" });
  });

  it("pessoa física: só o nome, nunca dígitos do CPF", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    await verification(org.id, owner.id, { legalType: "INDIVIDUAL", status: "APPROVED", legalName: "Maria Responsável", last4: "1234" });
    const id = await organizerIdentification(db, org.id);
    expect(id).toEqual({ legalType: "INDIVIDUAL", legalName: "Maria Responsável", cnpjLast4: null });
    expect(JSON.stringify(id)).not.toContain("1234");
  });

  it("sem verificação aprovada: null (pendente ou recusada não aparecem)", async () => {
    const owner = await makeUser();
    const org = await makeOrg(owner);
    await verification(org.id, owner.id, { legalType: "COMPANY", status: "SUBMITTED", legalName: "Não Aprovada LTDA", last4: "9999" });
    await verification(org.id, owner.id, { legalType: "COMPANY", status: "REJECTED", legalName: "Recusada LTDA", last4: "8888" });
    expect(await organizerIdentification(db, org.id)).toBeNull();
  });
});
