// E-mail aos responsáveis quando o admin aprova ou recusa o cadastro de organizador.
import { beforeEach, describe, expect, it } from "vitest";
import { decryptPII } from "@/server/crypto";
import { reviewOrganization, resubmitOrganizerApplication, submitOrganizerApplication } from "@/server/services/organizers";
import { db, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const application = (name: string) => ({ name, legalType: "COMPANY" as const, legalName: `${name} LTDA`, document: "11.222.333/0001-81", contactEmail: "contato@example.com" });

async function mails(template: string) {
  const rows = await db.emailOutbox.findMany({ where: { template }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ recipient: r.recipient, message: JSON.parse(decryptPII(r.messageEncrypted!)) as { subject: string; text: string } }));
}

describe("e-mail da decisão do cadastro de organizador", () => {
  it("aprovação avisa o responsável com o próximo passo (conta de recebimento)", async () => {
    const owner = await makeUser();
    const admin = await makeUser({ admin: true });
    const org = await submitOrganizerApplication(db, owner, application("Aprovada Mail"));
    await reviewOrganization(db, admin, org.id, "APPROVE");
    const sent = await mails("ORGANIZATION_APPROVED");
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toBe(owner.email.toLowerCase());
    expect(sent[0].message.subject).toContain("Seu cadastro de organizador");
    expect(sent[0].message.text).toContain("Aprovada Mail foi aprovada");
    expect(sent[0].message.text).toContain("Mercado Pago");
    expect(sent[0].message.text).toContain("/organizador");
    expect(await mails("ORGANIZATION_REJECTED")).toHaveLength(0);
  });

  it("recusa leva o motivo; cada reenvio recusado gera um novo aviso", async () => {
    const owner = await makeUser();
    const admin = await makeUser({ admin: true });
    const org = await submitOrganizerApplication(db, owner, application("Recusada Mail"));
    await reviewOrganization(db, admin, org.id, "REJECT", "CNPJ ilegível");
    await resubmitOrganizerApplication(db, owner, org.id, application("Recusada Mail"));
    await reviewOrganization(db, admin, org.id, "REJECT", "Razão social diferente do CNPJ");
    const sent = await mails("ORGANIZATION_REJECTED");
    expect(sent).toHaveLength(2);
    expect(sent[0].message.text).toContain("Motivo: CNPJ ilegível");
    expect(sent[1].message.text).toContain("Motivo: Razão social diferente do CNPJ");
    expect(sent[1].message.text).toContain("/organizador/cadastro");
    expect(sent[1].message.text).not.toContain("aprovada");
  });

  it("recusa com área diz o que ajustar; \"Outro\" e sem área não", async () => {
    const owner = await makeUser();
    const admin = await makeUser({ admin: true });
    const org = await submitOrganizerApplication(db, owner, application("Área Mail"));
    await reviewOrganization(db, admin, org.id, "REJECT", "Confira o documento", "LEGAL");
    await resubmitOrganizerApplication(db, owner, org.id, application("Área Mail"));
    await reviewOrganization(db, admin, org.id, "REJECT", "Confira tudo", "OTHER");
    await resubmitOrganizerApplication(db, owner, org.id, application("Área Mail"));
    await reviewOrganization(db, admin, org.id, "REJECT", "Sem área");
    const [legal, other, none] = await mails("ORGANIZATION_REJECTED");
    expect(legal.message.text).toContain("Ajuste pedido em Dados legais (razão social, nome completo, CPF/CNPJ).");
    expect(other.message.text).not.toContain("Ajuste pedido");
    expect(none.message.text).not.toContain("Ajuste pedido");
  });

  it("decisão que falha não envia nada", async () => {
    const owner = await makeUser();
    const admin = await makeUser({ admin: true });
    const org = await submitOrganizerApplication(db, owner, application("Sem aviso"));
    await reviewOrganization(db, admin, org.id, "APPROVE");
    await expect(reviewOrganization(db, admin, org.id, "REJECT", "Mudei de ideia")).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(reviewOrganization(db, await makeUser(), org.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await mails("ORGANIZATION_REJECTED")).toHaveLength(0);
    expect(await mails("ORGANIZATION_APPROVED")).toHaveLength(1);
  });
});
