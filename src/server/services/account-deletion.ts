import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { hashPassword, verifyPassword } from "../auth/password";
import { assertActive, type Actor } from "../auth/permissions";
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
    // Confere de novo dentro da transação: um pedido ou transferência pode ter surgido.
    const blockers = await accountDeletionBlockers(tx, user.id, now);
    if (blockers.length) throw new AppError("INVALID_STATE", DELETION_BLOCKER_TEXT[blockers[0]]);

    const marker = redactedEmail(user.id);
    const orders = await tx.order.updateMany({
      where: { userId: user.id, piiRedactedAt: null },
      data: { buyerName: REDACTED_NAME, buyerEmail: marker, buyerPhone: null, piiRedactedAt: now },
    });
    // Participantes nominados pelo comprador (podem ser terceiros) saem junto com o pedido.
    await tx.orderItem.updateMany({ where: { order: { userId: user.id } }, data: { attendees: Prisma.DbNull } });
    // Só ingressos de que a pessoa é titular: ingressos transferidos a outra pessoa
    // trazem os dados do novo titular, que não pediu exclusão.
    const tickets = await tx.issuedTicket.updateMany({
      where: { holderUserId: user.id, piiRedactedAt: null },
      data: { holderName: REDACTED_NAME, holderEmail: marker, piiRedactedAt: now },
    });
    const [sessions] = await Promise.all([
      tx.session.deleteMany({ where: { userId: user.id } }),
      tx.userAddress.deleteMany({ where: { userId: user.id } }),
      tx.passwordResetToken.deleteMany({ where: { userId: user.id } }),
      tx.emailVerificationToken.deleteMany({ where: { userId: user.id } }),
      tx.checkoutDraft.deleteMany({ where: { userId: user.id, orderId: null } }),
      tx.organizationMember.deleteMany({ where: { userId: user.id } }),
      tx.eventStaffAssignment.deleteMany({ where: { userId: user.id } }),
      tx.emailOutbox.deleteMany({ where: { recipient: { equals: user.email, mode: "insensitive" } } }),
      // Convites de equipe ainda abertos para este e-mail (o fato do convite fica na auditoria).
      tx.organizationInvitation.deleteMany({ where: { email: { equals: user.email, mode: "insensitive" }, acceptedAt: null } }),
    ]);
    await tx.user.update({
      where: { id: user.id },
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
        status: "SUSPENDED",
        suspendedReason: null,
        anonymizedAt: now,
      },
    });
    // Sem dado pessoal no metadata: a auditoria é imutável.
    await audit(tx, {
      actorUserId: user.id,
      action: "user.anonymized",
      entityType: "User",
      entityId: user.id,
      metadata: { orders: orders.count, tickets: tickets.count, sessions: sessions.count },
    });
    return { orders: orders.count, tickets: tickets.count };
  }, TX_OPTIONS);
}
