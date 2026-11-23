import type { Metadata } from "next";
import { LegalDocumentPage } from "@/components/site/legal-document-page";
import { PRIVACY_POLICY } from "@/content/legal";

export const metadata: Metadata = { title: PRIVACY_POLICY.title };

export default function PrivacyPage() {
  return <LegalDocumentPage doc={PRIVACY_POLICY} />;
}
