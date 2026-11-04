import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { hashPassword, verifyPassword } from "../auth/password";
import { assertActive, assertAdminPermission, type Actor } from "../auth/permissions";
import { assertCurrentTotp } from "./two-factor";
import { randomToken } from "../crypto";
import { AppError } from "../errors";
import { REDACTED_NAME, redactedEmail } from "../retention";

// Exclusão da conta pelo titular (LGPD art. 18, VI; Decreto 13.108/2026, R9; L9b).
// A linha User nunca é apagada (pedidos, ingressos, transferências e auditoria apontam
// para ela): os dados pessoais são trocados por marcadores e o acesso é encerrado.
// Valores, datas e status dos pedidos ficam (prova fiscal/de consumo; prazos em
// src/server/retention.ts). Histórico de transferências e auditoria são só de inserção
// e ficam como estão até a decisão D6.

export type DeletionBlocker =
  | "PLATFORM_ADMIN"
  | "ORGANIZATION_OWNER"
  | "OPEN_ORDER"
  | "UPCOMING_TICKET"
  | "PENDING_TRANSFER"
  | "OPEN_CANCELLATION";

export const DELETION_BLOCKER_TEXT: Record<DeletionBlocker, string> = {
  PLATFORM_ADMIN: "Contas de administrador da plataforma não podem ser excluídas por aqui. Peça a outro administrador para remover o seu acesso.",
  ORGANIZATION_OWNER: "Você é proprietário de uma organização. Passe a propriedade para outro membro antes de excluir a conta.",
  OPEN_ORDER: "Há pedido aguardando pagamento, com reembolso em andamento ou em contestação. Aguarde a conclusão ou cancele o pedido.",
  UPCOMING_TICKET: "Você tem ingressos válidos para eventos que ainda não terminaram. Transfira-os ou peça reembolso antes.",
  PENDING_TRANSFER: "Há transferência de ingresso pendente, enviada ou recebida. Cancele ou aguarde a decisão.",
  OPEN_CANCELLATION: "Há pedido de cancelamento aguardando resposta. Aguarde a resposta ou desista do pedido.",
};

const OPEN_ORDER_STATUSES = ["PENDING_PAYMENT", "REFUND_PENDING", "DISPUTED"] as const;

/** O que impede a exclusão agora; lista vazia = pode excluir. */
export async function accountDeletionBlockers(client: Db | Tx, userId: string, now = new Date()): Promise<DeletionBlocker[]> {
  const user = await client.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, platformRole: true } });
  const [owner, openOrder, upcoming, transfer, cancellation] = await Promise.all([
    client.organizationMember.count({ where: { userId, role: "OWNER" } }),
    client.order.count({ where: { userId, status: { in: [...OPEN_ORDER_STATUSES] } } }),
    client.issuedTicket.count({ where: { holderUserId: userId, status: "VALID", event: { endsAt: { gt: now } } } }),
    client.ticketTransfer.count({ where: { status: "PENDING", OR: [{ fromUserId: userId }, { toUserId: userId }, { toEmail: user.email.toLowerCase() }] } }),
    client.cancellationRequest.count({ where: { requestedById: userId, status: "OPEN" } }),
  ]);
  const blockers: DeletionBlocker[] = [];
  if (user.platformRole === "ADMIN") blockers.push("PLATFORM_ADMIN");
  if (owner) blockers.push("ORGANIZATION_OWNER");
  if (openOrder) blockers.push("OPEN_ORDER");
  if (upcoming) blockers.push("UPCOMING_TICKET");
  if (transfer) blockers.push("PENDING_TRANSFER");
  if (cancellation) blockers.push("OPEN_CANCELLATION");
  return blockers;
}

/**
 * Confirmação: senha (conta com senha) ou o próprio e-mail digitado (conta criada pelo
 * Google, cuja senha é aleatória e desconhecida do titular).
 */
export async function deleteOwnAccount(db: Db, actor: Actor, confirmation: { password?: string; email?: string }) {
  assertActive(actor);
  const user = await db.user.findUniqueOrThrow({
    where: { id: actor.id },
    select: { id: true, email: true, passwordHash: true, googleSubject: true, anonymizedAt: true },
  });
  if (user.anonymizedAt) throw new AppError("INVALID_STATE", "Esta conta já foi excluída.");
  const confirmed = user.googleSubject
    ? confirmation.email?.trim().toLowerCase() === user.email.toLowerCase()
    : await verifyPassword(confirmation.password ?? "", user.passwordHash);
  if (!confirmed) {
    throw new AppError("VALIDATION", user.googleSubject ? "Digite o e-mail da conta para confirmar." : "Senha incorreta.");
  }
  // Senha aleatória descartada: mesmo que o e-mail marcador fosse adivinhado, não há login.
  const unusablePassword = await hashPassword(randomToken(64));
  const now = new Date();

  return db.$transaction(async (tx) => {
    await lockUser(tx, user.id);
    // Confere de novo dentro da transação: um pedido ou transferência pode ter surgido.
    const blockers = await accountDeletionBlockers(tx, user.id, now);
    if (blockers.length) throw new AppError("INVALID_STATE", DELETION_BLOCKER_TEXT[blockers[0]]);

    const counts = await anonymizeAccountTx(tx, user.id, unusablePassword, now);
    // Sem dado pessoal no metadata: a auditoria é imutável.
    await audit(tx, {
      actorUserId: user.id,
      action: "user.anonymized",
      entityType: "User",
      entityId: user.id,
      metadata: { orders: counts.orders, tickets: counts.tickets, sessions: counts.sessions },
    });
    return { orders: counts.orders, tickets: counts.tickets };
  }, TX_OPTIONS);
}

/** Trava a linha do usuário e confirma que ainda não foi anonimizada (pedidos repetidos ou simultâneos). */
async function lockUser(tx: Tx, userId: string) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  const locked = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { anonymizedAt: true } });
  if (locked.anonymizedAt) throw new AppError("INVALID_STATE", "Esta conta já foi excluída.");
}

/**
 * Anonimização da conta (usada pelo titular e pelo superadmin), dentro da transação de quem
 * chama: dados pessoais viram marcadores, acessos são encerrados; valores, datas e status de
 * pedidos, pagamentos, reembolsos e a auditoria ficam.
 */
async function anonymizeAccountTx(tx: Tx, userId: string, unusablePassword: string, now: Date) {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const marker = redactedEmail(userId);
  const orders = await tx.order.updateMany({
    where: { userId, piiRedactedAt: null },
    data: { buyerName: REDACTED_NAME, buyerEmail: marker, buyerPhone: null, piiRedactedAt: now },
  });
  // Participantes nominados pelo comprador (podem ser terceiros) saem junto com o pedido.
  await tx.orderItem.updateMany({ where: { order: { userId } }, data: { attendees: Prisma.DbNull } });
  // Só ingressos de que a pessoa é titular: ingressos transferidos a outra pessoa
  // trazem os dados do novo titular, que não pediu exclusão.
  const tickets = await tx.issuedTicket.updateMany({
    where: { holderUserId: userId, piiRedactedAt: null },
    data: { holderName: REDACTED_NAME, holderEmail: marker, piiRedactedAt: now },
  });
  const [sessions, , , , , , memberships] = await Promise.all([
    tx.session.deleteMany({ where: { userId } }),
    tx.userAddress.deleteMany({ where: { userId } }),
    tx.passwordResetToken.deleteMany({ where: { userId } }),
    tx.emailVerificationToken.deleteMany({ where: { userId } }),
    tx.checkoutDraft.deleteMany({ where: { userId, orderId: null } }),
    tx.totpRecoveryCode.deleteMany({ where: { userId } }),
    tx.organizationMember.deleteMany({ where: { userId } }),
    tx.eventStaffAssignment.deleteMany({ where: { userId } }),
    tx.emailOutbox.deleteMany({ where: { recipient: { equals: user.email, mode: "insensitive" } } }),
    // Convites de equipe ainda abertos para este e-mail (o fato do convite fica na auditoria).
    tx.organizationInvitation.deleteMany({ where: { email: { equals: user.email, mode: "insensitive" }, acceptedAt: null } }),
  ]);
  await tx.user.update({
    where: { id: userId },
    data: {
      name: REDACTED_NAME,
      email: marker,
      phone: null,
      passwordHash: unusablePassword,
      emailVerifiedAt: null,
      cpfEncrypted: null,
      cpfHash: null,
      cpfLast2: null,
      birthDate: null,
      googleSubject: null,
      totpSecretEncrypted: null,
      totpEnabledAt: null,
      totpLastStep: null,
      totpPendingSecretEncrypted: null,
      totpPendingAt: null,
      status: "SUSPENDED",
      suspendedReason: null,
      anonymizedAt: now,
    },
  });
  return { orders: orders.count, tickets: tickets.count, sessions: sessions.count, memberships: memberships.count };
}

// ---------------------------------------------------------------------------
// Exclusão definitiva pelo superadmin (contas de clientes e organizadores).
// Mesma anonimização do titular; os bloqueios olham também as organizações em que a
// conta é a única proprietária, para não deixar compradores sem quem responda por eles.
// ---------------------------------------------------------------------------

export type AdminDeletionBlocker =
  | Exclude<DeletionBlocker, "ORGANIZATION_OWNER">
  | "ORG_SHARED_LAST_OWNER"
  | "ORG_ACTIVE_EVENTS"
  | "ORG_VALID_TICKETS"
  | "ORG_OPEN_ORDERS"
  | "ORG_PENDING_REFUNDS"
  | "ORG_PENDING_SETTLEMENT"
  | "ORG_OPEN_CANCELLATIONS";

const ADMIN_BLOCKER_TEXT: Record<AdminDeletionBlocker, (org?: string) => string> = {
  PLATFORM_ADMIN: () => "É uma conta de administrador da plataforma; administradores não são excluídos por aqui.",
  OPEN_ORDER: () => "Há pedido da pessoa aguardando pagamento, com reembolso em andamento ou em contestação.",
  UPCOMING_TICKET: () => "A pessoa tem ingressos válidos para eventos que ainda não terminaram (ela perderia o acesso a eles).",
  PENDING_TRANSFER: () => "Há transferência de ingresso pendente, enviada ou recebida pela pessoa.",
  OPEN_CANCELLATION: () => "Há pedido de cancelamento da pessoa aguardando resposta.",
  ORG_SHARED_LAST_OWNER: (o) => `A pessoa é a única proprietária da organização "${o}", que tem outros membros. Um novo proprietário precisa ser definido na equipe antes.`,
  ORG_ACTIVE_EVENTS: (o) => `A organização "${o}" tem eventos publicados ou em análise que ainda não terminaram.`,
  ORG_VALID_TICKETS: (o) => `A organização "${o}" tem ingressos válidos vendidos para eventos que ainda não terminaram.`,
  ORG_OPEN_ORDERS: (o) => `A organização "${o}" tem pedidos aguardando pagamento, com reembolso em andamento ou em contestação.`,
  ORG_PENDING_REFUNDS: (o) => `A organização "${o}" tem reembolsos pendentes ou com falha.`,
  ORG_PENDING_SETTLEMENT: (o) => `A organização "${o}" tem repasse pendente, em trânsito ou com falha.`,
  ORG_OPEN_CANCELLATIONS: (o) => `A organização "${o}" tem pedidos de cancelamento aguardando resposta.`,
};

export type AdminDeletionCheck = {
  blockers: { code: AdminDeletionBlocker; organizationId?: string; message: string }[];
  /** Organizações que ficariam sem nenhum membro: são suspensas (os registros ficam). */
  orphanedOrganizationIds: string[];
};

/** O que impede o superadmin de excluir a conta agora (lista vazia = pode excluir). */
export async function adminAccountDeletionCheck(client: Db | Tx, userId: string, now = new Date()): Promise<AdminDeletionCheck> {
  const own = (await accountDeletionBlockers(client, userId, now)).filter(
    (b): b is Exclude<DeletionBlocker, "ORGANIZATION_OWNER"> => b !== "ORGANIZATION_OWNER",
  );
  const blockers: AdminDeletionCheck["blockers"] = own.map((code) => ({ code, message: ADMIN_BLOCKER_TEXT[code]() }));
  const orphanedOrganizationIds: string[] = [];

  const owned = await client.organizationMember.findMany({
    where: { userId, role: "OWNER" },
    select: { organization: { select: { id: true, name: true, members: { where: { userId: { not: userId } }, select: { role: true } } } } },
  });
  for (const { organization: org } of owned) {
    // Há outro proprietário: só o vínculo desta pessoa sai; a organização segue com a equipe.
    if (org.members.some((m) => m.role === "OWNER")) continue;
    const add = (code: AdminDeletionBlocker) => blockers.push({ code, organizationId: org.id, message: ADMIN_BLOCKER_TEXT[code](org.name) });
    if (org.members.length) add("ORG_SHARED_LAST_OWNER");
    const [activeEvents, validTickets, openOrders, pendingRefunds, pendingSettlements, openCancellations] = await Promise.all([
      client.event.count({ where: { organizationId: org.id, status: { in: ["PUBLISHED", "PENDING_REVIEW"] }, endsAt: { gt: now } } }),
      client.issuedTicket.count({ where: { status: "VALID", event: { organizationId: org.id, endsAt: { gt: now } } } }),
      client.order.count({ where: { organizationId: org.id, status: { in: [...OPEN_ORDER_STATUSES] } } }),
      client.refund.count({ where: { order: { organizationId: org.id }, status: { in: ["REQUESTED", "PROCESSING", "FAILED"] } } }),
      client.organizerSettlement.count({ where: { organizationId: org.id, status: { in: ["PENDING", "IN_TRANSIT", "FAILED"] } } }),
      client.cancellationRequest.count({ where: { organizationId: org.id, status: "OPEN" } }),
    ]);
    if (activeEvents) add("ORG_ACTIVE_EVENTS");
    if (validTickets) add("ORG_VALID_TICKETS");
    if (openOrders) add("ORG_OPEN_ORDERS");
    if (pendingRefunds) add("ORG_PENDING_REFUNDS");
    if (pendingSettlements) add("ORG_PENDING_SETTLEMENT");
    if (openCancellations) add("ORG_OPEN_CANCELLATIONS");
    if (!org.members.length) orphanedOrganizationIds.push(org.id);
  }
  return { blockers, orphanedOrganizationIds };
}

export const ORPHANED_ORG_REASON = "Conta do responsável excluída pela plataforma";

type Blockers = AdminDeletionCheck["blockers"];
const ADMIN_ACCOUNT_BLOCKER: Blockers = [{ code: "PLATFORM_ADMIN", message: ADMIN_BLOCKER_TEXT.PLATFORM_ADMIN() }];

/**
 * Exclusão definitiva pelo superadmin. Confirmação explícita: o e-mail da conta digitado,
 * o motivo e o código do autenticador do próprio superadmin. Tudo numa transação: ou a
 * conta é anonimizada por inteiro (com as organizações órfãs suspensas), ou nada muda.
 * Tentativas bloqueadas ou com falha também ficam na auditoria.
 */
export async function adminDeleteAccount(
  db: Db,
  admin: Actor,
  targetUserId: string,
  input: { confirmEmail: string; reason: string; adminCode: string },
  now = new Date(),
) {
  assertAdminPermission(admin, "users:delete");
  if (targetUserId === admin.id) throw new AppError("VALIDATION", "Você não pode excluir a própria conta por aqui.");
  const reason = input.reason.trim();
  if (reason.length < 5) throw new AppError("VALIDATION", "Descreva o motivo da exclusão (mínimo de 5 caracteres).");
  if (reason.length > 500) throw new AppError("VALIDATION", "O motivo pode ter no máximo 500 caracteres.");

  const target = await db.user.findUnique({ where: { id: targetUserId }, select: { email: true, platformRole: true, anonymizedAt: true } });
  if (!target) throw new AppError("NOT_FOUND", "Usuário não encontrado.");
  if (target.anonymizedAt) throw new AppError("INVALID_STATE", "Esta conta já foi excluída.");
  if (input.confirmEmail.trim().toLowerCase() !== target.email.toLowerCase())
    throw new AppError("VALIDATION", "Digite exatamente o e-mail da conta para confirmar.");

  const rejectBlocked = async (blockers: Blockers): Promise<never> => {
    await audit(db, {
      actorUserId: admin.id,
      action: "user.deletion_blocked",
      entityType: "User",
      entityId: targetUserId,
      metadata: { result: "BLOCKED", blockers: blockers.map((b) => (b.organizationId ? `${b.code}:${b.organizationId}` : b.code)), reason },
    });
    throw new AppError("INVALID_STATE", ["A conta não pode ser excluída agora:", ...blockers.map((b) => `• ${b.message}`)].join("\n"));
  };
  if (target.platformRole === "ADMIN") return rejectBlocked(ADMIN_ACCOUNT_BLOCKER);
  // Antes do código do autenticador: um impedimento não gasta o código do superadmin.
  const precheck = await adminAccountDeletionCheck(db, targetUserId, now);
  if (precheck.blockers.length) return rejectBlocked(precheck.blockers);

  const adminAccount = await db.user.findUniqueOrThrow({ where: { id: admin.id }, select: { totpEnabledAt: true } });
  if (!adminAccount.totpEnabledAt) throw new AppError("FORBIDDEN", "Ative a sua verificação em duas etapas antes de excluir contas.");
  await assertCurrentTotp(db, admin.id, input.adminCode, now);

  const unusablePassword = await hashPassword(randomToken(64));
  let outcome: { blocked: Blockers } | { blocked: null; counts: Awaited<ReturnType<typeof anonymizeAccountTx>>; suspendedOrganizations: string[] };
  try {
    outcome = await db.$transaction(async (tx) => {
      await lockUser(tx, targetUserId);
      // Conferências de novo sob a trava: algo pode ter mudado desde a abertura da tela.
      const locked = await tx.user.findUniqueOrThrow({ where: { id: targetUserId }, select: { platformRole: true } });
      if (locked.platformRole === "ADMIN") return { blocked: ADMIN_ACCOUNT_BLOCKER };
      const check = await adminAccountDeletionCheck(tx, targetUserId, now);
      if (check.blockers.length) return { blocked: check.blockers };

      const counts = await anonymizeAccountTx(tx, targetUserId, unusablePassword, now);
      // Organização sem nenhum membro não vende mais; eventos, pedidos e razão ficam como prova.
      for (const organizationId of check.orphanedOrganizationIds) {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
        const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { status: true } });
        if (org.status === "SUSPENDED") continue;
        await tx.organization.update({ where: { id: organizationId }, data: { status: "SUSPENDED", statusReason: ORPHANED_ORG_REASON } });
        await audit(tx, {
          actorUserId: admin.id,
          organizationId,
          action: "organization.suspended",
          entityType: "Organization",
          entityId: organizationId,
          metadata: { previousStatus: org.status, newStatus: "SUSPENDED", reason: ORPHANED_ORG_REASON },
        });
      }
      // Só identificadores e contagens: nada de nome, e-mail ou documento na auditoria imutável.
      await audit(tx, {
        actorUserId: admin.id,
        action: "user.deleted_by_admin",
        entityType: "User",
        entityId: targetUserId,
        metadata: { result: "ANONYMIZED", reason, ...counts, suspendedOrganizations: check.orphanedOrganizationIds },
      });
      return { blocked: null, counts, suspendedOrganizations: check.orphanedOrganizationIds };
    }, TX_OPTIONS);
  } catch (error) {
    // A transação desfez tudo; registra a tentativa (melhor esforço) e devolve o erro.
    if (!(error instanceof AppError)) {
      await audit(db, {
        actorUserId: admin.id,
        action: "user.deletion_failed",
        entityType: "User",
        entityId: targetUserId,
        metadata: { result: "FAILED", reason },
      }).catch(() => undefined);
    }
    throw error;
  }
  if (outcome.blocked) return rejectBlocked(outcome.blocked);
  return { ...outcome.counts, suspendedOrganizations: outcome.suspendedOrganizations };
}
