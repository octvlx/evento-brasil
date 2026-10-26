// Rótulos pt-BR para enums do banco (seguro para cliente).

export const ORDER_STATUS: Record<string, { label: string; tone: "default" | "success" | "warning" | "danger" }> = {
  PENDING_PAYMENT: { label: "Aguardando pagamento", tone: "warning" },
  PAID: { label: "Pago", tone: "success" },
  PAYMENT_FAILED: { label: "Pagamento recusado", tone: "danger" },
  EXPIRED: { label: "Expirado", tone: "default" },
  CANCELLED: { label: "Cancelado", tone: "default" },
  REFUND_PENDING: { label: "Reembolso em andamento", tone: "warning" },
  REFUNDED: { label: "Reembolsado", tone: "default" },
  DISPUTED: { label: "Em disputa", tone: "danger" },
};

export const PAYMENT_STATUS: Record<string, string> = {
  PENDING: "Pendente",
  PAID: "Pago",
  FAILED: "Recusado",
  EXPIRED: "Expirado",
  CANCELLED: "Cancelado",
  REFUNDED: "Estornado",
  DISPUTED: "Em disputa",
  CHARGED_BACK: "Chargeback",
};

export const TICKET_STATUS: Record<string, { label: string; tone: "default" | "success" | "warning" | "danger" }> = {
  VALID: { label: "Válido", tone: "success" },
  CHECKED_IN: { label: "Utilizado", tone: "default" },
  REVOKED: { label: "Cancelado", tone: "danger" },
};

export const EVENT_STATUS: Record<string, { label: string; tone: "default" | "success" | "warning" | "danger" }> = {
  DRAFT: { label: "Rascunho", tone: "default" },
  PENDING_REVIEW: { label: "Em análise", tone: "warning" },
  PUBLISHED: { label: "Publicado", tone: "success" },
  CANCELLED: { label: "Cancelado", tone: "danger" },
  COMPLETED: { label: "Encerrado", tone: "default" },
  ARCHIVED: { label: "Arquivado", tone: "default" },
};

export const ORG_STATUS: Record<string, { label: string; tone: "default" | "success" | "warning" | "danger" }> = {
  DRAFT: { label: "Rascunho", tone: "default" },
  PENDING_REVIEW: { label: "Em análise", tone: "warning" },
  APPROVED: { label: "Aprovada", tone: "success" },
  REJECTED: { label: "Rejeitada", tone: "danger" },
  SUSPENDED: { label: "Suspensa", tone: "danger" },
};

export const TICKET_KIND: Record<string, string> = {
  GENERAL: "Inteira",
  VIP: "VIP",
  PROMOTIONAL: "Promocional",
  EARLY_BIRD: "Lote antecipado",
  HALF_PRICE: "Meia-entrada",
  FREE: "Gratuito",
};

export const ORG_ROLE: Record<string, string> = {
  OWNER: "Responsável",
  ADMIN: "Administrador",
  EVENT_MANAGER: "Gestor de eventos",
  FINANCE: "Financeiro",
  CHECKIN_STAFF: "Equipe de check-in",
};

export const PAYMENT_ACCOUNT_STATUS: Record<string, string> = {
  NOT_CONNECTED: "Não conectada",
  PENDING: "Pendente",
  CONNECTED: "Conectada",
  SIMULATED: "Simulada (desenvolvimento)",
  DISABLED: "Desabilitada",
};

export const REFUND_STATUS: Record<string, string> = {
  REQUESTED: "Solicitado",
  PROCESSING: "Processando",
  SUCCEEDED: "Concluído",
  REJECTED: "Recusado",
  FAILED: "Falhou",
};

export const REFUND_REASON: Record<string, string> = {
  CUSTOMER_REQUEST: "Solicitação do cliente",
  EVENT_CANCELLED: "Evento cancelado",
  LATE_PAYMENT_NO_INVENTORY: "Pagamento após expiração (sem estoque)",
  ADMIN: "Administrativo",
};

export const CHECKIN_RESULT: Record<string, string> = {
  ADMITTED: "Entrada liberada",
  DUPLICATE: "Duplicado",
  WRONG_EVENT: "Outro evento",
  REVOKED: "Cancelado",
  INVALID: "Inválido",
  EVENT_NOT_ACTIVE: "Evento inativo",
};

export const AVAILABILITY: Record<string, { label: string; tone: "default" | "success" | "warning" | "danger" }> = {
  AVAILABLE: { label: "Disponível", tone: "success" },
  LOW: { label: "Últimos ingressos", tone: "warning" },
  SOLD_OUT: { label: "Esgotado", tone: "danger" },
  NOT_STARTED: { label: "Vendas em breve", tone: "default" },
  CLOSED: { label: "Vendas encerradas", tone: "default" },
};

export const toneToBadge = { default: "default", success: "success", warning: "warning", danger: "danger" } as const;
