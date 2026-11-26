import "server-only";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { verifyPassword } from "../auth/password";
import { assertAdminPermission, assertOrgPermission, type Actor } from "../auth/permissions";
import { enqueueEmail } from "../email/outbox";
import { transactionalEmail } from "../email/templates";
import { env } from "../env";
import { AppError, forbidden, invalidState, notFound } from "../errors";
import { organizerReceivableCents } from "./ledger";
import { assertCurrentTotp } from "./two-factor";
import {
  canTransitionDeletionRequest,
  DELETED_ORG_REASON,
  deletedOrgEmail,
  deletedOrgSlug,
  deletionConfirmationMatches,
  normalizeDeletionReason,
  orgDeletionBlockedMessage,
  orgDeletionBlockers,
  type OrgDeletionBlocker,
} from "@/lib/organization-deletion";

// Exclusão de conta de organizador (organização).
//
// "Excluir" é exclusão lógica, nunca DELETE: pedidos, pagamentos, reembolsos, ingressos,
// o razão (partidas dobradas), repasses, verificações (dados fiscais) e a auditoria
// apontam para a organização e precisam ficar pelo prazo de guarda legal. A exclusão:
//   - marca deletedAt e deixa a organização SUSPENDED (sai da vitrine e não vende mais);
//   - apaga o perfil público e o contato (descrição, site, Instagram, logo, capa, telefone)
//     e libera o slug; o nome fica, porque aparece nos pedidos e recibos dos compradores;
//   - tira os eventos da vitrine (rascunhos e em análise viram arquivados);
//   - encerra membros, atribuições de portaria, convites e transferência de responsável;
//   - desconecta o Mercado Pago (tokens apagados, autorização revogada).
// É bloqueada enquanto houver venda ativa, dinheiro em trânsito ou pendência com comprador.
//
// Dois caminhos: o superadmin exclui direto (adminDeleteOrganization) ou o responsável
// (OWNER) pede em /organizador/configuracoes e o superadmin aprova (a aprovação executa a
// mesma exclusão) ou recusa. Só o papel SUPER_ADMIN tem "organizers:delete".

const OPEN_ORDER_STATUSES = ["PENDING_PAYMENT", "REFUND_PENDING", "DISPUTED"] as const;
const OPEN_REFUND_STATUSES = ["AWAITING_APPROVAL", "REQUESTED", "PROCESSING", "FAILED"] as const;
const OPEN_SETTLEMENT_STATUSES = ["PENDING", "IN_TRANSIT", "FAILED"] as const;

/** O que impede a exclusão agora (lista vazia = pode excluir). */
export async function organizationDeletionBlockers(client: Db | Tx, organizationId: string, now = new Date()): Promise<OrgDeletionBlocker[]> {
  const [activeEvents, validTickets, paidOrdersUpcoming, openOrders, pendingRefunds, pendingSettlements, openCancellations] = await Promise.all([
    client.event.count({ where: { organizationId, status: { in: ["PUBLISHED", "PENDING_REVIEW"] }, endsAt: { gt: now } } }),
    client.issuedTicket.count({ where: { status: "VALID", event: { organizationId, endsAt: { gt: now } } } }),
    client.order.count({ where: { organizationId, status: "PAID", event: { endsAt: { gt: now } } } }),
    client.order.count({ where: { organizationId, status: { in: [...OPEN_ORDER_STATUSES] } } }),
    client.refund.count({ where: { order: { organizationId }, status: { in: [...OPEN_REFUND_STATUSES] } } }),
    client.organizerSettlement.count({ where: { organizationId, status: { in: [...OPEN_SETTLEMENT_STATUSES] } } }),
    client.cancellationRequest.count({ where: { organizationId, status: "OPEN" } }),
  ]);
  // organizerReceivableCents só lê (groupBy); aceita o cliente fora de transação também.
  const organizerDebtCents = await organizerReceivableCents(client as Tx, organizationId);
  return orgDeletionBlockers({ activeEvents, validTickets, paidOrdersUpcoming, openOrders, pendingRefunds, pendingSettlements, organizerDebtCents, openCancellations });
}

async function lockOrganization(tx: Tx, organizationId: string) {
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR UPDATE`;
  return tx.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true, status: true, deletedAt: true } });
}

const alreadyDeleted = () => invalidState("Esta organização já foi excluída.");

function validationFrom(fn: () => string | null): string | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RangeError) throw new AppError("VALIDATION", e.message);
    throw e;
  }
}

/** Só o responsável (OWNER) pede ou cancela. Vale também com a organização suspensa. */
async function assertOwner(client: Db | Tx, actor: Actor, organizationId: string) {
  const { role } = await assertOrgPermission(client, actor, organizationId, "org:read");
  if (role !== "OWNER") throw forbidden("Só o responsável (OWNER) pode pedir a exclusão da organização.");
}

/** Confirma a senha de quem pede (conta só com login do Google não tem senha própria). */
export async function confirmPassword(db: Db, userId: string, password: string | undefined) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, googleSubject: true } });
  if (user.googleSubject && !password) return;
  if (!password || !(await verifyPassword(password, user.passwordHash))) throw new AppError("FORBIDDEN", "Senha incorreta.");
}

// ───────────────────────────── Pedido do organizador ─────────────────────────────

/** Último pedido da organização (para a tela de configurações). */
export async function latestOrganizationDeletionRequest(db: Db, actor: Actor, organizationId: string) {
  await assertOwner(db, actor, organizationId);
  return db.organizationDeletionRequest.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, reason: true, decisionNote: true, createdAt: true, decidedAt: true },
  });
}

/**
 * O responsável pede a exclusão, confirmando com a senha. Nada muda na organização até a
 * decisão do superadmin. Com impedimento, o pedido nem é criado e os motivos voltam.
 */
export async function requestOrganizationDeletion(
  db: Db,
  actor: Actor,
  organizationId: string,
  input: { password?: string; reason?: string },
  now = new Date(),
) {
  const reason = validationFrom(() => (input.reason?.trim() ? normalizeDeletionReason(input.reason, { required: false }) : null));
  await assertOwner(db, actor, organizationId);
  await confirmPassword(db, actor.id, input.password);
  return db.$transaction(async (tx) => {
    const org = await lockOrganization(tx, organizationId);
    if (!org) throw notFound("Organização não encontrada.");
    if (org.deletedAt) throw alreadyDeleted();
    // De novo sob a trava: o papel pode ter mudado entre a tela e o envio.
    await assertOwner(tx, actor, organizationId);
    const pending = await tx.organizationDeletionRequest.findFirst({ where: { organizationId, status: "PENDING" }, select: { id: true } });
    if (pending) throw invalidState("Já há um pedido de exclusão aguardando a plataforma.");
    const blockers = await organizationDeletionBlockers(tx, organizationId, now);
    if (blockers.length) throw invalidState(orgDeletionBlockedMessage(blockers, "Ainda não dá para pedir a exclusão:"));
    const request = await tx.organizationDeletionRequest.create({ data: { organizationId, requestedById: actor.id, reason, createdAt: now } });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "organization.deletion_requested",
      entityType: "OrganizationDeletionRequest",
      entityId: request.id,
      metadata: { reason },
    });
    return request;
  }, TX_OPTIONS);
}

/** O responsável desiste enquanto o pedido está pendente. */
export async function cancelOrganizationDeletionRequest(db: Db, actor: Actor, organizationId: string, now = new Date()) {
  await assertOwner(db, actor, organizationId);
  return db.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const request = await tx.organizationDeletionRequest.findFirst({ where: { organizationId, status: "PENDING" } });
    if (!request) throw notFound("Não há pedido de exclusão pendente.");
    await decideRequestTx(tx, request.id, "CANCELLED", { decidedAt: now });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId,
      action: "organization.deletion_request_cancelled",
      entityType: "OrganizationDeletionRequest",
      entityId: request.id,
    });
  }, TX_OPTIONS);
}

/** Muda o status só a partir de PENDING (decisões simultâneas: a segunda perde aqui). */
async function decideRequestTx(
  tx: Tx,
  requestId: string,
  to: "APPROVED" | "REJECTED" | "CANCELLED",
  data: { decidedAt: Date; decidedById?: string; decisionNote?: string | null },
) {
  if (!canTransitionDeletionRequest("PENDING", to)) throw invalidState("Transição de pedido inválida.");
  const { count } = await tx.organizationDeletionRequest.updateMany({ where: { id: requestId, status: "PENDING" }, data: { status: to, ...data } });
  if (count !== 1) throw invalidState("Este pedido de exclusão já foi decidido ou cancelado.");
}

// ───────────────────────────── Superadmin ─────────────────────────────

/** Fila do admin: pedidos pendentes com os impedimentos atuais de cada organização. */
export async function listPendingOrganizationDeletionRequests(db: Db, admin: Actor, now = new Date()) {
  assertAdminPermission(admin, "organizers:delete");
  const requests = await db.organizationDeletionRequest.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    include: { organization: { select: { id: true, name: true } }, requestedBy: { select: { name: true, email: true } } },
  });
  return Promise.all(requests.map(async (r) => ({ ...r, blockers: await organizationDeletionBlockers(db, r.organizationId, now) })));
}

/** Recusa o pedido (com motivo, que vai para o responsável). */
export async function rejectOrganizationDeletionRequest(db: Db, admin: Actor, requestId: string, note: string, now = new Date()) {
  assertAdminPermission(admin, "organizers:delete");
  const decisionNote = validationFrom(() => normalizeDeletionReason(note, { required: true }));
  return db.$transaction(async (tx) => {
    const request = await tx.organizationDeletionRequest.findUnique({
      where: { id: requestId },
      include: { organization: { select: { name: true } }, requestedBy: { select: { email: true } } },
    });
    if (!request) throw notFound("Pedido não encontrado.");
    await lockOrganization(tx, request.organizationId);
    await decideRequestTx(tx, request.id, "REJECTED", { decidedAt: now, decidedById: admin.id, decisionNote });
    await audit(tx, {
      actorUserId: admin.id,
      organizationId: request.organizationId,
      action: "organization.deletion_request_rejected",
      entityType: "OrganizationDeletionRequest",
      entityId: request.id,
      metadata: { note: decisionNote },
    });
    await enqueueEmail(tx, {
      dedupeKey: `org-deletion:${request.id}:rejected`,
      template: "ORGANIZATION_DELETION_REJECTED",
      recipient: request.requestedBy.email,
      message: transactionalEmail(
        "organizer",
        "Pedido de exclusão recusado",
        [`A plataforma recusou o pedido de exclusão de ${request.organization.name}. A organização continua ativa como estava.`, `Motivo: ${decisionNote}`],
        env().APP_URL + "/organizador/configuracoes",
      ),
    });
  }, TX_OPTIONS);
}

/**
 * Exclusão lógica pelo superadmin, direta ou aprovando um pedido (`requestId`).
 * Confirmação explícita: o nome da organização digitado, o motivo e o código do
 * autenticador do próprio superadmin. Tudo numa transação: ou exclui por inteiro, ou
 * nada muda. Tentativas bloqueadas também ficam na auditoria.
 */
export async function adminDeleteOrganization(
  db: Db,
  admin: Actor,
  organizationId: string,
  input: { confirmName: string; reason: string; adminCode: string; requestId?: string },
  now = new Date(),
) {
  assertAdminPermission(admin, "organizers:delete");
  const reason = validationFrom(() => normalizeDeletionReason(input.reason, { required: true }))!;

  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { name: true, deletedAt: true } });
  if (!org) throw notFound("Organização não encontrada.");
  if (org.deletedAt) throw alreadyDeleted();
  if (!deletionConfirmationMatches(input.confirmName, org.name)) throw new AppError("VALIDATION", "Digite exatamente o nome da organização para confirmar.");
  if (input.requestId) {
    const request = await db.organizationDeletionRequest.findUnique({ where: { id: input.requestId }, select: { organizationId: true, status: true } });
    if (!request || request.organizationId !== organizationId) throw notFound("Pedido não encontrado.");
    if (request.status !== "PENDING") throw invalidState("Este pedido de exclusão já foi decidido ou cancelado.");
  }

  const rejectBlocked = async (blockers: OrgDeletionBlocker[]): Promise<never> => {
    await audit(db, {
      actorUserId: admin.id,
      organizationId,
      action: "organization.deletion_blocked",
      entityType: "Organization",
      entityId: organizationId,
      metadata: { result: "BLOCKED", blockers, reason, requestId: input.requestId ?? null },
    });
    throw invalidState(orgDeletionBlockedMessage(blockers));
  };
  // Antes do código do autenticador: um impedimento não gasta o código do superadmin.
  const precheck = await organizationDeletionBlockers(db, organizationId, now);
  if (precheck.length) return rejectBlocked(precheck);

  const adminAccount = await db.user.findUniqueOrThrow({ where: { id: admin.id }, select: { totpEnabledAt: true } });
  if (!adminAccount.totpEnabledAt) throw new AppError("FORBIDDEN", "Ative a sua verificação em duas etapas antes de excluir organizações.");
  await assertCurrentTotp(db, admin.id, input.adminCode, now);

  const outcome = await db.$transaction(async (tx) => {
    const locked = await lockOrganization(tx, organizationId);
    if (!locked) throw notFound("Organização não encontrada.");
    if (locked.deletedAt) throw alreadyDeleted();
    // Conferência de novo sob a trava: uma venda pode ter começado desde a abertura da tela.
    const blockers = await organizationDeletionBlockers(tx, organizationId, now);
    if (blockers.length) return { blocked: blockers };

    const owners = await tx.organizationMember.findMany({ where: { organizationId, role: "OWNER" }, select: { user: { select: { email: true } } } });
    const counts = await softDeleteOrganizationTx(tx, organizationId, now);

    // O pedido aprovado (ou qualquer pendente, numa exclusão direta) fica resolvido.
    const pending = await tx.organizationDeletionRequest.findMany({ where: { organizationId, status: "PENDING" }, select: { id: true } });
    for (const r of pending) await decideRequestTx(tx, r.id, "APPROVED", { decidedAt: now, decidedById: admin.id, decisionNote: reason });
    if (input.requestId && !pending.some((r) => r.id === input.requestId)) throw invalidState("Este pedido de exclusão já foi decidido ou cancelado.");

    await audit(tx, {
      actorUserId: admin.id,
      organizationId,
      action: "organization.deleted",
      entityType: "Organization",
      entityId: organizationId,
      metadata: { result: "DELETED", reason, previousStatus: locked.status, requestId: input.requestId ?? null, approvedRequests: pending.map((r) => r.id), ...counts },
    });
    for (const { user } of owners) {
      await enqueueEmail(tx, {
        dedupeKey: `org-deletion:${organizationId}:deleted:${user.email.toLowerCase()}`,
        template: "ORGANIZATION_DELETED",
        recipient: user.email,
        message: transactionalEmail(
          "organizer",
          "Organização excluída",
          [
            `A organização ${locked.name} foi excluída da plataforma${input.requestId ? ", como você pediu" : ""}.`,
            "Os registros de vendas, pagamentos e reembolsos ficam guardados pelo prazo legal. Se você não reconhece esta exclusão, fale com o atendimento.",
          ],
          env().APP_URL + "/ajuda#contato",
        ),
      });
    }
    return { blocked: null, counts };
  }, TX_OPTIONS);
  if (outcome.blocked) return rejectBlocked(outcome.blocked);
  return outcome.counts;
}

/** Aplica a exclusão lógica dentro da transação de quem chama (organização já travada). */
async function softDeleteOrganizationTx(tx: Tx, organizationId: string, now: Date) {
  // Eventos que nunca venderam (rascunho/em análise já terminados) saem do ciclo; os que
  // venderam ficam como prova, mas nenhum aparece mais na vitrine.
  const archivedEvents = await tx.event.updateMany({ where: { organizationId, status: { in: ["DRAFT", "PENDING_REVIEW"] } }, data: { status: "ARCHIVED" } });
  await tx.event.updateMany({ where: { organizationId, status: "PUBLISHED", endsAt: { lte: now } }, data: { status: "COMPLETED" } });
  await tx.event.updateMany({ where: { organizationId }, data: { isUnlisted: true, isFeatured: false } });

  const staff = await tx.eventStaffAssignment.deleteMany({ where: { event: { organizationId } } });
  const members = await tx.organizationMember.deleteMany({ where: { organizationId } });
  const invitations = await tx.organizationInvitation.updateMany({ where: { organizationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
  await tx.organizationOwnershipTransfer.updateMany({ where: { organizationId, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: now } });

  // Mercado Pago: autorização revogada e tokens apagados (não há mais cobrança nem split).
  const mp = await tx.mercadoPagoAccount.updateMany({ where: { organizationId }, data: { revokedAt: now, accessTokenEncrypted: "", refreshTokenEncrypted: "" } });

  await tx.organization.update({
    where: { id: organizationId },
    data: {
      deletedAt: now,
      status: "SUSPENDED",
      statusReason: DELETED_ORG_REASON,
      statusReasonArea: null,
      slug: deletedOrgSlug(organizationId),
      description: null,
      contactEmail: deletedOrgEmail(organizationId),
      contactPhone: null,
      websiteUrl: null,
      instagramHandle: null,
      logoUrl: null,
      coverUrl: null,
      autoPublishEvents: false,
      paymentAccountStatus: "DISABLED",
      paymentAccountExternalId: null,
    },
  });
  return {
    archivedEvents: archivedEvents.count,
    removedMembers: members.count,
    removedStaffAssignments: staff.count,
    revokedInvitations: invitations.count,
    mercadoPagoDisconnected: mp.count > 0,
  };
}
