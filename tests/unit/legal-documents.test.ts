import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUYER_TERMS, LEGAL_DOCUMENTS, legalDocumentHash, pendingPlaceholders, PRIVACY_POLICY, type LegalDocument } from "@/content/legal";
import { RETENTION } from "@/server/retention";
import { PROVISIONAL_CANCELLATION_RESPONSE_DAYS } from "@/server/services/cancellation-requests";
import { ARREPENDIMENTO_DAYS } from "@/server/services/refunds";

const text = (doc: LegalDocument) => doc.sections.flatMap((s) => s.blocks.flatMap((b) => (typeof b === "string" ? [b] : b.list))).join("\n");

describe("documentos legais", () => {
  it("um documento por tipo, com página, versão curta e seções sem repetição", () => {
    expect(LEGAL_DOCUMENTS.map((d) => d.kind).sort()).toEqual(["BUYER", "ORGANIZER", "PRIVACY"]);
    for (const doc of LEGAL_DOCUMENTS) {
      expect(doc.version.length).toBeLessThanOrEqual(32);
      expect(existsSync(path.join("src/app", doc.path, "page.tsx"))).toBe(true);
      expect(new Set(doc.sections.map((s) => s.title)).size).toBe(doc.sections.length);
      expect(doc.sections.every((s) => s.blocks.length > 0)).toBe(true);
    }
  });

  it("hash: SHA-256 do texto exibido, estável e fora das notas de revisão", () => {
    for (const doc of LEGAL_DOCUMENTS) expect(legalDocumentHash(doc)).toMatch(/^[0-9a-f]{64}$/);
    expect(legalDocumentHash({ ...BUYER_TERMS, reviewNotes: ["outra nota"] })).toBe(legalDocumentHash(BUYER_TERMS));
    const edited = { ...BUYER_TERMS, sections: [{ title: "x", blocks: ["y"] }] };
    expect(legalDocumentHash(edited)).not.toBe(legalDocumentHash(BUYER_TERMS));
  });

  it("aponta os campos da empresa ainda não preenchidos", () => {
    expect(pendingPlaceholders(BUYER_TERMS)).toContain("[A PREENCHER: razão social]");
    expect(pendingPlaceholders({ ...BUYER_TERMS, sections: [{ title: "x", blocks: ["texto final"] }] })).toEqual([]);
  });

  it("os prazos do texto batem com as regras do sistema", () => {
    const buyer = text(BUYER_TERMS);
    expect(buyer).toContain(`até ${ARREPENDIMENTO_DAYS} dias depois da compra`);
    expect(buyer).toContain(`respondemos em até ${PROVISIONAL_CANCELLATION_RESPONSE_DAYS} dias`);

    const privacy = text(PRIVACY_POLICY);
    expect(privacy).toContain(`até ${RETENTION.orderPiiYearsAfterEvent} anos após o fim do evento`);
    expect(privacy).toContain(`${RETENTION.checkinDaysAfterEvent} dias após o fim do evento`);
    expect(privacy).toContain(`${RETENTION.chargeDataHoursAfterSettled} horas depois`);
    expect(privacy).toContain(`Notificações recebidas do Mercado Pago: ${RETENTION.webhookPayloadDays} dias`);
    expect(privacy).toContain(`E-mails enviados: ${RETENTION.emailOutboxDays} dias`);
  });
});
