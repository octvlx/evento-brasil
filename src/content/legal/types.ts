// Documentos legais como dados: a página renderiza este conteúdo e o hash registrado em
// TermsVersion.textHash é calculado sobre ele (src/content/legal/hash.ts). Assim, o
// aceite fica preso exatamente ao texto exibido.

/** Parágrafo (texto) ou lista de itens. */
export type LegalBlock = string | { list: string[] };

export interface LegalSection {
  title: string;
  blocks: LegalBlock[];
}

export interface LegalDocument {
  kind: "BUYER" | "PRIVACY" | "ORGANIZER";
  title: string;
  /** Vai para TermsVersion.version (até 32 caracteres). Texto novo = versão nova. */
  version: string;
  /** Página onde o texto é exibido (TermsVersion.documentPath). */
  path: string;
  /** Data da redação exibida no topo (AAAA-MM-DD). */
  updatedAt: string;
  sections: LegalSection[];
  /**
   * Pontos para a revisão jurídica. Não são exibidos nem entram no hash: servem para
   * quem revisa o texto antes da publicação.
   */
  reviewNotes: string[];
}
