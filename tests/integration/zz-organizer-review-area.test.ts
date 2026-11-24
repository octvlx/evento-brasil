// Recusa de cadastro de organizador com a área a corrigir: gravada na recusa,
// apagada no reenvio e na suspensão, e registrada na auditoria.
import { beforeEach, describe, expect, it } from "vitest";
import { reviewOrganization, resubmitOrganizerApplication, setOrganizationSuspended, submitOrganizerApplication } from "@/server/services/organizers";
import { db, makeUser, resetDb } from "../support/fixtures";

beforeEach(resetDb);

const application = (name: string) => ({ name, legalType: "COMPANY" as const, legalName: `${name} LTDA`, document: "11.222.333/0001-81", contactEmail: "contato@example.com" });

describe("área da recusa do cadastro de organizador", () => {
  it("grava a área na recusa e a apaga no reenvio", async () => {
    const owner = await makeUser();
    const admin = await makeUser({ admin: true });
    const org = await submitOrganizerApplication(db, owner, application("Área"));
    const rejected = await reviewOrganization(db, admin, org.id, "REJECT", "CNPJ ilegível", "LEGAL");
    expect(rejected).toMatchObject({ status: "REJECTED", statusReason: "CNPJ ilegível", statusReasonArea: "LEGAL" });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "organization.rejected", entityId: org.id } });
    expect(log.metadata).toMatchObject({ area: "LEGAL", note: "CNPJ ilegível" });

    const again = await resubmitOrganizerApplication(db, owner, org.id, application("Área"));
    expect(again).toMatchObject({ status: "PENDING_REVIEW", statusReason: null, statusReasonArea: null });
  });

  it("aprovação não guarda área; recusa sem área continua valendo (texto do motivo)", async () => {
    const owner = await makeUser();
    const admin = await makeUser({ admin: true });
    const a = await submitOrganizerApplication(db, owner, application("Aprovada"));
    expect(await reviewOrganization(db, admin, a.id, "APPROVE", undefined, "LEGAL")).toMatchObject({ status: "APPROVED", statusReasonArea: null });
    const b = await submitOrganizerApplication(db, owner, application("Sem área"));
    expect(await reviewOrganization(db, admin, b.id, "REJECT", "Faltam dados")).toMatchObject({ status: "REJECTED", statusReasonArea: null });
  });

  it("recusa com área inválida é recusada; suspensão não herda a área", async () => {
    const owner = await makeUser();
    const admin = await makeUser({ admin: true });
    const org = await submitOrganizerApplication(db, owner, application("Inválida"));
    await expect(reviewOrganization(db, admin, org.id, "REJECT", "x y z", "QUALQUER" as never)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ status: "PENDING_REVIEW" });
    await reviewOrganization(db, admin, org.id, "APPROVE");
    expect(await setOrganizationSuspended(db, admin, org.id, true, "Fraude")).toMatchObject({ status: "SUSPENDED", statusReasonArea: null });
  });
});
