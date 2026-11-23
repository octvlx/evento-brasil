import type { Metadata } from "next";
import { LegalDocumentPage } from "@/components/site/legal-document-page";
import { ORGANIZER_TERMS } from "@/content/legal";

export const metadata: Metadata = { title: ORGANIZER_TERMS.title };

export default function OrganizerTermsPage() {
  return <LegalDocumentPage doc={ORGANIZER_TERMS} />;
}
