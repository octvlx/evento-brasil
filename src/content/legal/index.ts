import { createHash } from "node:crypto";
import { BUYER_TERMS } from "./buyer";
import { PLACEHOLDER_MARK } from "./company";
import { ORGANIZER_TERMS } from "./organizer";
import { PRIVACY_POLICY } from "./privacy";
import type { LegalDocument } from "./types";

export type { LegalBlock, LegalDocument, LegalSection } from "./types";
export { BUYER_TERMS, ORGANIZER_TERMS, PRIVACY_POLICY };

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [BUYER_TERMS, PRIVACY_POLICY, ORGANIZER_TERMS];

/** O que a página exibe (sem as notas de revisão), na ordem em que exibe. */
function displayed(doc: LegalDocument) {
  return { kind: doc.kind, title: doc.title, version: doc.version, updatedAt: doc.updatedAt, sections: doc.sections };
}

/** SHA-256 hex do texto exibido: vai para TermsVersion.textHash. */
export function legalDocumentHash(doc: LegalDocument): string {
  return createHash("sha256").update(JSON.stringify(displayed(doc))).digest("hex");
}

/** Campos ainda não preenchidos ("[A PREENCHER: …]"), sem repetição. */
export function pendingPlaceholders(doc: LegalDocument): string[] {
  const text = JSON.stringify(displayed(doc));
  const found = text.match(/\[A PREENCHER[^\]]*\]/g) ?? [];
  return [...new Set(found)];
}

export const isLegalDraft = (doc: LegalDocument) => JSON.stringify(displayed(doc)).includes(PLACEHOLDER_MARK);
