// Regras puras da exclusão de organização (sem banco): bloqueios, confirmação e as
// transições do pedido de exclusão. O serviço (server/services/organization-deletion.ts) conta os
// registros e aplica estas regras; os testes unitários as exercitam direto.
import type { OrganizationDeletionRequestStatus } from "@/generated/prisma/client";

export type OrgDeletionBlocker =
  | "ACTIVE_EVENTS"
  | "VALID_TICKETS"
  | "PAID_ORDERS_UPCOMING"
  | "OPEN_ORDERS"
  | "PENDING_REFUNDS"
  | "PENDING_SETTLEMENT"
  | "ORGANIZER_DEBT"
  | "OPEN_CANCELLATIONS";

export const ORG_DELETION_BLOCKER_TEXT: Record<OrgDeletionBlocker, string> = {
  ACTIVE_EVENTS: "Há eventos publicados ou em análise que ainda não terminaram. Cancele-os (com reembolso) ou aguarde o fim deles.",
  VALID_TICKETS: "Há ingressos válidos vendidos para eventos que ainda não terminaram.",
  PAID_ORDERS_UPCOMING: "Há pedidos pagos, não reembolsados, de eventos que ainda não terminaram.",
  OPEN_ORDERS: "Há pedidos aguardando pagamento, com reembolso em andamento ou em contestação.",
  PENDING_REFUNDS: "Há reembolsos aguardando aprovação, em processamento ou com falha.",
  PENDING_SETTLEMENT: "Há repasse ao organizador pendente, em trânsito ou com falha.",
  ORGANIZER_DEBT: "Há saldo devedor do organizador com a plataforma no razão financeiro.",
  OPEN_CANCELLATIONS: "Há pedidos de cancelamento de compradores aguardando resposta.",
};

/** Contagens que a exclusão confere (todas precisam ser zero; dívida em centavos). */
export type OrgDeletionCounts = {
  activeEvents: number;
  validTickets: number;
  paidOrdersUpcoming: number;
  openOrders: number;
  pendingRefunds: number;
  pendingSettlements: number;
  organizerDebtCents: number;
  openCancellations: number;
};

export function orgDeletionBlockers(c: OrgDeletionCounts): OrgDeletionBlocker[] {
  const blockers: OrgDeletionBlocker[] = [];
  if (c.activeEvents > 0) blockers.push("ACTIVE_EVENTS");
  if (c.validTickets > 0) blockers.push("VALID_TICKETS");
  if (c.paidOrdersUpcoming > 0) blockers.push("PAID_ORDERS_UPCOMING");
  if (c.openOrders > 0) blockers.push("OPEN_ORDERS");
  if (c.pendingRefunds > 0) blockers.push("PENDING_REFUNDS");
  if (c.pendingSettlements > 0) blockers.push("PENDING_SETTLEMENT");
  if (c.organizerDebtCents > 0) blockers.push("ORGANIZER_DEBT");
  if (c.openCancellations > 0) blockers.push("OPEN_CANCELLATIONS");
  return blockers;
}

/** Mensagem única com todos os motivos (uma linha por bloqueio). */
export function orgDeletionBlockedMessage(blockers: readonly OrgDeletionBlocker[], intro = "A organização não pode ser excluída agora:") {
  return [intro, ...blockers.map((b) => `• ${ORG_DELETION_BLOCKER_TEXT[b]}`)].join("\n");
}

/** Confirmação digitada: o nome da organização (sem diferenciar maiúsculas e espaços nas pontas). */
export function deletionConfirmationMatches(typed: string, organizationName: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
  return typed.trim().length > 0 && norm(typed) === norm(organizationName);
}

/** Motivo do superadmin: obrigatório, 5 a 500 caracteres (vai para a auditoria). */
export function normalizeDeletionReason(raw: string | undefined | null, { required }: { required: boolean }): string | null {
  const reason = (raw ?? "").trim();
  if (!reason) {
    if (required) throw new RangeError("Descreva o motivo (mínimo de 5 caracteres).");
    return null;
  }
  if (reason.length < 5) throw new RangeError("Descreva o motivo (mínimo de 5 caracteres).");
  if (reason.length > 500) throw new RangeError("O motivo pode ter no máximo 500 caracteres.");
  return reason;
}

/** Transições do pedido de exclusão: só um pedido pendente é decidido ou cancelado. */
const REQUEST_TRANSITIONS: Record<OrganizationDeletionRequestStatus, readonly OrganizationDeletionRequestStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransitionDeletionRequest(from: OrganizationDeletionRequestStatus, to: OrganizationDeletionRequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

export const DELETION_REQUEST_STATUS: Record<OrganizationDeletionRequestStatus, { label: string; tone: "default" | "success" | "warning" | "danger" }> = {
  PENDING: { label: "Aguardando a plataforma", tone: "warning" },
  APPROVED: { label: "Aprovado — organização excluída", tone: "success" },
  REJECTED: { label: "Recusado", tone: "danger" },
  CANCELLED: { label: "Cancelado por você", tone: "default" },
};

/** Motivo gravado em Organization.statusReason na exclusão lógica. */
export const DELETED_ORG_REASON = "Conta de organizador excluída";
export const deletedOrgSlug = (organizationId: string) => `excluida-${organizationId}`;
export const deletedOrgEmail = (organizationId: string) => `organizacao-excluida+${organizationId}@anonimo.invalid`;
