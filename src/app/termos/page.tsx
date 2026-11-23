import type { Metadata } from "next";
import { LegalDocumentPage } from "@/components/site/legal-document-page";
import { BUYER_TERMS } from "@/content/legal";

export const metadata: Metadata = { title: BUYER_TERMS.title };

export default function TermsPage() {
  return <LegalDocumentPage doc={BUYER_TERMS} />;
}
