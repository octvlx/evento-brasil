// Dados da empresa que opera a TICKET24, usados nos três documentos legais.
// Enquanto houver "[A PREENCHER", as páginas mostram o aviso de minuta e o script
// de publicação (npm run terms:publish) se recusa a gravar a versão.

export const PLACEHOLDER_MARK = "[A PREENCHER";

export const COMPANY = {
  legalName: "[A PREENCHER: razão social]",
  cnpj: "[A PREENCHER: CNPJ]",
  address: "[A PREENCHER: endereço completo da sede]",
  /** Também publicado na Central de ajuda (/ajuda#contato). */
  supportEmail: "suporte@ticket24.com.br",
  dpoName: "[A PREENCHER: nome do encarregado de dados]",
  dpoEmail: "[A PREENCHER: e-mail do encarregado de dados]",
  /** Foro do contrato com organizadores (relação entre empresas). */
  organizerVenue: "[A PREENCHER: comarca do foro]",
} as const;

/** "TICKET24, operada por <razão social>, CNPJ <cnpj>, com sede em <endereço>". */
export const COMPANY_IDENTIFICATION = `A TICKET24 é operada por ${COMPANY.legalName}, inscrita no CNPJ sob o nº ${COMPANY.cnpj}, com sede em ${COMPANY.address} ("TICKET24", "nós").`;
