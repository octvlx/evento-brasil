// Prazos de retenção (L9b; proposta em docs/dados-pessoais-e-retencao.md).
//
// PROVISÓRIOS: a decisão D6 (jurídico) ainda não saiu. Os valores seguem a proposta
// do inventário L9a e o lado conservador quando há dúvida: dados que podem servir de
// prova fiscal ou de consumo ficam mais tempo; dados só operacionais saem cedo.
// Mudar aqui muda o expurgo (src/server/services/retention-purge.ts) e a documentação.
export const RETENTION = {
  /** Comprador, participantes e titular dos ingressos: anos após o fim do evento (prazo fiscal/consumo usual de 5 anos). */
  orderPiiYearsAfterEvent: 5,
  /** Leituras do check-in: dias após o fim do evento (cobre a janela de contestação do pagamento). */
  checkinDaysAfterEvent: 180,
  /** QR/copia e cola do PIX e link do checkout: horas depois que o pagamento sai de PENDING. */
  chargeDataHoursAfterSettled: 24,
  /** Corpo dos webhooks de pagamento: dias após o recebimento (o id externo fica para idempotência). */
  webhookPayloadDays: 180,
  /** E-mails transacionais encerrados (destinatário e mensagem cifrada): dias após a criação. */
  emailOutboxDays: 90,
  /** Convites de equipe aceitos, revogados ou vencidos: dias (o fato fica na auditoria). */
  invitationDays: 90,
  /** Tokens de senha/verificação e carrinhos sem pedido: dias após vencerem. */
  expiredTokenDays: 7,
} as const;

/** Mantidos sem prazo de expurgo até D6: razão, repasses, auditoria, aceites de termos e
 * histórico de transferências (Decreto 13.108/2026: no mínimo 2 anos; tabela só de inserção). */
export const RETENTION_KEPT = ["FinancialLedgerEntry", "OrganizerSettlement", "AuditLog", "TermsAcceptance", "TicketTransfer"] as const;

/** Marcadores no lugar dos dados pessoais anonimizados. */
export const REDACTED_NAME = "Conta excluída";
export const redactedEmail = (id: string) => `excluido+${id}@anonimo.invalid`;
