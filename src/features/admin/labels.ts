// Rótulos pt-BR usados só nas telas do admin (os compartilhados ficam em @/lib/labels).

export const CANCELLATION_STATUS: Record<string, string> = {
  OPEN: "Em análise",
  APPROVED: "Aprovado",
  REJECTED: "Recusado",
  WITHDRAWN: "Desistência do comprador",
};

export const TRANSFER_STATUS: Record<string, string> = {
  PENDING: "Aguardando aceite",
  ACCEPTED: "Aceita",
  CANCELLED: "Cancelada/recusada",
  EXPIRED: "Expirada",
};

export const TRANSFER_INITIATOR: Record<string, string> = {
  HOLDER: "Titular",
  ADMIN: "Admin",
};

/** Inclui EVENT_CHANGED (R8), que ainda não está em @/lib/labels. */
export const ADMIN_REFUND_REASON: Record<string, string> = {
  CUSTOMER_REQUEST: "Solicitação do cliente",
  EVENT_CANCELLED: "Evento cancelado",
  LATE_PAYMENT_NO_INVENTORY: "Pagamento após expiração (sem estoque)",
  ADMIN: "Administrativo",
  EVENT_CHANGED: "Alteração relevante do evento",
};
