import { ProsePage } from "@/components/site/prose-page";
import { isLegalDraft, type LegalDocument } from "@/content/legal";

const dateBR = (iso: string) => iso.split("-").reverse().join("/");

/** Página de um documento legal versionado (termos, privacidade, organizador). */
export function LegalDocumentPage({ doc }: { doc: LegalDocument }) {
  const notice = isLegalDraft(doc) ? "Minuta em revisão jurídica: alguns dados da empresa ainda serão preenchidos antes da publicação." : undefined;
  return (
    <ProsePage title={doc.title} notice={notice}>
      <p className="text-sm text-muted-foreground">
        Versão {doc.version}, de {dateBR(doc.updatedAt)}.
      </p>
      {doc.sections.map((section) => (
        <section key={section.title} className="space-y-4">
          <h2>{section.title}</h2>
          {section.blocks.map((block, i) =>
            typeof block === "string" ? (
              <p key={i}>{block}</p>
            ) : (
              <ul key={i} className="space-y-2">
                {block.list.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ),
          )}
        </section>
      ))}
    </ProsePage>
  );
}
