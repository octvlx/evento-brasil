// Transferência de titularidade (Decreto 13.108/2026, R6): gratuita, entre contas
// autenticadas, rastreável e com histórico imutável (TicketTransfer, gatilho
// TicketTransfer_append_only — sem DELETE, linha decidida não muda).
//
// Fluxo: o titular pede (PENDING, token de aceite de uso único, só o hash fica no
// banco) → o destinatário, logado com o e-mail indicado, aceita ou recusa; o
// titular pode cancelar; o cron de manutenção expira as vencidas.
//
// No aceite o ingresso muda de titular e ganha um NOVO validationToken: o QR, o
// PDF e os passes de carteira anteriores deixam de valer na portaria.
//
// Ordem de travas (a mesma de check-in, reembolso e cancelamento):
// Event → Order → IssuedTicket → TicketTransfer. O aceite trava o Event com
// FOR UPDATE, como createOrder, porque confere o limite por conta (contrato a);
// isso também o serializa com o check-in (FOR KEY SHARE no Event), então uma
// leitura vê o token antigo ou o novo, nunca uma mistura. O prazo configurado
// pelo evento é reconferido sob a trava tanto no pedido quanto no aceite.
import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { audit } from "../audit";
import { assertActive, type Actor } from "../auth/permissions";
import { hashToken, randomToken } from "../crypto";
import { env } from "../env";
import { escapeHtml } from "../email";
import { enqueueEmail, dispatchEmailOutbox } from "../email/outbox";
import { AppError, invalidState, notFound } from "../errors";
import { formatEventDateTime } from "@/lib/datetime";
import { lockEvent, ticketsHeldByAccount } from "./orders";
import {
  DEFAULT_TRANSFER_POLICY,
  TRANSFER_ACCEPT_WINDOW_HOURS,
  transferCutoff,
  type TransferPolicy,
} from "@/lib/transfer-policy";

/** decisionReason da recusa pelo destinatário (a página de aceite distingue de cancelamento). */
export const DECLINED_BY_RECIPIENT = "Recusada pelo destinatário";

/** Compatibilidade com consumidores antigos; a regra efetiva sempre vem do evento. */
export const TRANSFER_POLICY = {
  maxTransfersPerTicket: DEFAULT_TRANSFER_POLICY.transferMaxTransfers,
  acceptWindowHours: TRANSFER_ACCEPT_WINDOW_HOURS,
} as const;

export const requestTransferSchema = z.object({
  toEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Informe um e-mail válido.")
    .max(254),
  toName: z
    .string()
    .trim()
    .min(2, "Informe o nome de quem vai receber o ingresso.")
    .max(200),
});
export type RequestTransferInput = z.input<typeof requestTransferSchema>;

/** IP e agente do navegador, guardados no histórico (opcionais). */
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const meta = (m: RequestMeta = {}) => ({
  ip: m.ip?.slice(0, 64) ?? null,
  userAgent: m.userAgent?.slice(0, 512) ?? null,
});

async function lockOrderShared(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR KEY SHARE`;
}

async function lockTicket(tx: Tx, ticketId: string) {
  await tx.$queryRaw`SELECT id FROM "IssuedTicket" WHERE id = ${ticketId} FOR UPDATE`;
}

async function lockTransfer(tx: Tx, transferId: string) {
  await tx.$queryRaw`SELECT id FROM "TicketTransfer" WHERE id = ${transferId} FOR UPDATE`;
}

const ticketWithContext = {
  order: { select: { status: true } },
  event: {
    select: {
      status: true,
      startsAt: true,
      title: true,
      timezone: true,
      organizationId: true,
      maxTicketsPerAccount: true,
      transferDeadlineHours: true,
      transferMaxTransfers: true,
      transferAllowReturn: true,
    },
  },
} satisfies Prisma.IssuedTicketInclude;
type TicketWithContext = Prisma.IssuedTicketGetPayload<{
  include: typeof ticketWithContext;
}>;

/** Mínimo de que `transferBlockedReason` precisa (a página do ingresso passa o próprio include). */
interface TransferableTicket {
  status: TicketWithContext["status"];
  order: { status: TicketWithContext["order"]["status"] };
  event: {
    status: TicketWithContext["event"]["status"];
    startsAt: Date;
  } & TransferPolicy;
}

/**
 * Regras comuns a pedir e aceitar. `null` = transferível. Exportada para a página do
 * ingresso decidir se mostra "Transferir"; o serviço reconfere tudo sob as travas.
 */
export function transferBlockedReason(
  t: TransferableTicket,
  now: Date,
): string | null {
  if (t.status === "CHECKED_IN") return "Este ingresso já foi utilizado.";
  if (t.status !== "VALID")
    return "Este ingresso foi cancelado ou reembolsado.";
  if (t.order.status !== "PAID")
    return "O pedido deste ingresso não está pago ou tem reembolso em andamento.";
  if (t.event.status !== "PUBLISHED") return "O evento não está mais ativo.";
  if (t.event.startsAt.getTime() <= now.getTime())
    return "O evento já começou: não é mais possível transferir.";
  if (now.getTime() >= transferCutoff(t.event.startsAt, t.event).getTime())
    return `O prazo para transferir encerrou: ${t.event.transferDeadlineHours} hora(s) antes do evento.`;
  return null;
}

/** Identidade estável mais e-mails históricos: trocar e-mail não permite receber de volta. */
export async function transferRecipientBlockedReason(
  db: Db | Tx,
  ticketId: string,
  buyerId: string,
  recipient: { id?: string; email: string },
  allowReturn: boolean,
): Promise<string | null> {
  if (allowReturn) return null;
  const email = recipient.email.toLowerCase();
  const account = recipient.id
    ? { id: recipient.id }
    : await db.user.findUnique({ where: { email }, select: { id: true } });
  const previousHolder =
    account?.id === buyerId ||
    !!(await db.ticketTransfer.findFirst({
      where: {
        ticketId,
        status: "ACCEPTED",
        OR: [
          ...(account
            ? [{ fromUserId: account.id }, { toUserId: account.id }]
            : []),
          { fromHolderEmail: email },
          { toEmail: email },
        ],
      },
      select: { id: true },
    }));
  return previousHolder
    ? "Este evento não permite devolver o ingresso a um titular anterior."
    : null;
}

async function enforceTransferPolicy(
  tx: Tx,
  t: TicketWithContext,
  recipient: { id?: string; email: string },
) {
  const accepted = await tx.ticketTransfer.count({
    where: { ticketId: t.id, status: "ACCEPTED" },
  });
  if (accepted >= t.event.transferMaxTransfers) {
    throw new AppError(
      "LIMIT_EXCEEDED",
      `Este ingresso já atingiu o limite de ${t.event.transferMaxTransfers} transferência(s).`,
    );
  }
  const blocked = await transferRecipientBlockedReason(
    tx,
    t.id,
    t.userId,
    recipient,
    t.event.transferAllowReturn,
  );
  if (blocked) throw invalidState(blocked);
}

const isUniqueViolation = (err: unknown) =>
  !!err &&
  typeof err === "object" &&
  "code" in err &&
  (err as { code: unknown }).code === "P2002";

export interface TransferRequested {
  transferId: string;
  expiresAt: Date;
}

// O token também volta a quem pediu (testes e um futuro "copiar link"): sozinho ele não
// aceita nada, pois o aceite exige a conta logada com o e-mail do destinatário.
// A Server Action não o repassa ao navegador.
export interface TransferRequestedWithToken extends TransferRequested {
  token: string;
}

/** O titular atual pede a transferência. Gratuita: não cria pedido nem cobrança. */
export async function requestTransfer(
  db: Db,
  holder: Actor,
  ticketId: string,
  input: RequestTransferInput,
  requestMeta?: RequestMeta,
  at?: Date,
): Promise<TransferRequestedWithToken> {
  assertActive(holder);
  const parsed = requestTransferSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "Dados inválidos.",
    );
  const data = parsed.data;
  const ticket = await db.issuedTicket.findUnique({
    where: { id: ticketId },
    select: { eventId: true, orderId: true, holderUserId: true },
  });
  // Mesma resposta para inexistente e de outra pessoa (não revela existência).
  if (!ticket || ticket.holderUserId !== holder.id)
    throw notFound("Ingresso não encontrado.");
  const token = randomToken(32);
  const m = meta(requestMeta);

  let created: {
    id: string;
    expiresAt: Date;
    ticket: TicketWithContext;
    fromName: string;
  };
  try {
    created = await db.$transaction(async (tx) => {
      await lockEvent(tx, ticket.eventId);
      await lockOrderShared(tx, ticket.orderId);
      await lockTicket(tx, ticketId);
      const now = at ?? new Date();
      const t = await tx.issuedTicket.findUniqueOrThrow({
        where: { id: ticketId },
        include: ticketWithContext,
      });
      if (t.holderUserId !== holder.id)
        throw notFound("Ingresso não encontrado.");
      const blocked = transferBlockedReason(t, now);
      if (blocked) throw invalidState(blocked);
      const from = await tx.user.findUniqueOrThrow({
        where: { id: holder.id },
        select: { email: true, name: true },
      });
      if (from.email.toLowerCase() === data.toEmail)
        throw new AppError("VALIDATION", "Informe o e-mail de outra pessoa.");
      await enforceTransferPolicy(tx, t, { email: data.toEmail });
      // Convite vencido que o cron ainda não expirou não pode travar um novo pedido (índice
      // único de uma pendente por ingresso): expira aqui, sob a trava do ingresso, como o cron.
      await tx.ticketTransfer.updateMany({
        where: { ticketId, status: "PENDING", expiresAt: { lte: now } },
        data: { status: "EXPIRED", decidedAt: now },
      });
      const expiresAt = new Date(
        Math.min(
          now.getTime() + TRANSFER_ACCEPT_WINDOW_HOURS * 3_600_000,
          transferCutoff(t.event.startsAt, t.event).getTime(),
        ),
      );
      const fromName = t.holderName ?? from.name;
      const row = await tx.ticketTransfer.create({
        data: {
          ticketId,
          eventId: t.eventId,
          initiatedBy: "HOLDER",
          fromUserId: holder.id,
          fromHolderName: fromName.slice(0, 200),
          fromHolderEmail: from.email.toLowerCase(),
          toEmail: data.toEmail,
          toHolderName: data.toName,
          tokenHash: hashToken(token),
          createdById: holder.id,
          createdAt: now,
          expiresAt,
          requestIp: m.ip,
          requestUserAgent: m.userAgent,
        },
      });
      await audit(tx, {
        actorUserId: holder.id,
        organizationId: t.event.organizationId,
        action: "ticket.transfer.requested",
        entityType: "TicketTransfer",
        entityId: row.id,
        metadata: { ticketId, expiresAt: expiresAt.toISOString() },
      });
      const message = transferInviteEmail({
        to: data.toEmail,
        toName: data.toName,
        fromName,
        token,
        expiresAt,
        event: t.event,
      });
      await enqueueEmail(tx, {
        dedupeKey: `transfer-invite:${row.id}`,
        template: "TRANSFER_INVITATION",
        recipient: message.to,
        message,
        expiresAt,
      });
      return { id: row.id, expiresAt, ticket: t, fromName };
    }, TX_OPTIONS);
  } catch (err) {
    // Índice único parcial: no máximo uma pendente por ingresso.
    if (isUniqueViolation(err))
      throw new AppError(
        "CONFLICT",
        "Já existe uma transferência pendente para este ingresso.",
      );
    throw err;
  }

  kickEmailWorker(db);
  return { transferId: created.id, expiresAt: created.expiresAt, token };
}

/** Transferência pendente pelo token do link (página de aceite). Null se inválido. */
export async function findTransferByToken(db: Db, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.ticketTransfer.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      status: true,
      toEmail: true,
      toUserId: true,
      toHolderName: true,
      fromUserId: true,
      fromHolderName: true,
      expiresAt: true,
      decidedAt: true,
      decisionReason: true,
      // status do ingresso, do pedido e do evento: a página avisa antes do clique quando o
      // ingresso não pode mais ser transferido (transferBlockedReason).
      ticket: {
        select: {
          id: true,
          userId: true,
          code: true,
          status: true,
          _count: { select: { transfers: { where: { status: "ACCEPTED" } } } },
          ticketType: { select: { name: true } },
          order: { select: { status: true } },
        },
      },
      event: {
        select: {
          title: true,
          startsAt: true,
          timezone: true,
          status: true,
          transferDeadlineHours: true,
          transferMaxTransfers: true,
          transferAllowReturn: true,
        },
      },
    },
  });
}

/**
 * Como o destinatário chega à transferência: pelo token do link do e-mail ou, logado,
 * pelo id listado em "Meus ingressos" (`listMyTransfers`). As mesmas regras valem nos dois.
 */
export type RecipientTransferRef = string | { transferId: string };

async function findForRecipient(db: Db, ref: RecipientTransferRef) {
  if (typeof ref !== "string")
    return db.ticketTransfer.findUnique({ where: { id: ref.transferId } });
  return /^[A-Za-z0-9_-]{43}$/.test(ref)
    ? db.ticketTransfer.findUnique({ where: { tokenHash: hashToken(ref) } })
    : null;
}

async function pendingForRecipient(
  db: Db,
  recipient: Actor,
  ref: RecipientTransferRef,
) {
  assertActive(recipient);
  const transfer = await findForRecipient(db, ref);
  if (!transfer) throw notFound("Transferência não encontrada.");
  const user = await db.user.findUniqueOrThrow({
    where: { id: recipient.id },
    select: { email: true, name: true, emailVerifiedAt: true },
  });
  if (!user.emailVerifiedAt)
    throw new AppError(
      "FORBIDDEN",
      "Confirme seu e-mail antes de responder a uma transferência.",
    );
  // O link sozinho não basta: precisa estar logado com o e-mail indicado pelo titular.
  if (user.email.toLowerCase() !== transfer.toEmail)
    throw new AppError(
      "FORBIDDEN",
      "Esta transferência foi enviada para outro e-mail. Entre com a conta desse e-mail para responder.",
    );
  if (transfer.fromUserId === recipient.id)
    throw new AppError(
      "VALIDATION",
      "Você não pode aceitar uma transferência feita por você.",
    );
  return { transfer, user };
}

export interface TransferAccepted {
  ticketCode: string;
}

/**
 * O destinatário aceita. Tudo é reconferido sob as travas; o ingresso só muda de
 * titular se ainda estiver VALID e com o mesmo titular do pedido, e ganha novo QR.
 */
export async function acceptTransfer(
  db: Db,
  recipient: Actor,
  token: RecipientTransferRef,
  decisionMeta?: RequestMeta,
  at?: Date,
): Promise<TransferAccepted> {
  const { transfer, user } = await pendingForRecipient(db, recipient, token);
  const ticketRef = await db.issuedTicket.findUniqueOrThrow({
    where: { id: transfer.ticketId },
    select: { orderId: true },
  });
  const m = meta(decisionMeta);

  const outcome = await db.$transaction(
    async (
      tx,
    ): Promise<
      | { expired: true }
      | {
          expired: false;
          ticket: TicketWithContext;
        }
    > => {
      await lockEvent(tx, transfer.eventId);
      await lockOrderShared(tx, ticketRef.orderId);
      await lockTicket(tx, transfer.ticketId);
      await lockTransfer(tx, transfer.id);
      const now = at ?? new Date();

      const current = await tx.ticketTransfer.findUniqueOrThrow({
        where: { id: transfer.id },
      });
      if (current.status !== "PENDING")
        throw invalidState(
          current.status === "ACCEPTED"
            ? "Esta transferência já foi aceita."
            : "Esta transferência não está mais disponível.",
        );
      if (!current.expiresAt || current.expiresAt.getTime() <= now.getTime()) {
        await tx.ticketTransfer.update({
          where: { id: current.id },
          data: { status: "EXPIRED", decidedAt: now },
        });
        return { expired: true };
      }
      const t = await tx.issuedTicket.findUniqueOrThrow({
        where: { id: transfer.ticketId },
        include: ticketWithContext,
      });
      const blocked = transferBlockedReason(t, now);
      if (blocked) throw invalidState(blocked);
      if (t.holderUserId !== current.fromUserId)
        throw invalidState(
          "O ingresso mudou de titular depois do pedido de transferência.",
        );

      await enforceTransferPolicy(tx, t, {
        id: recipient.id,
        email: user.email,
      });

      // Contrato (a) com pagamentos-financeiro: a mesma contagem do createOrder, sob a
      // mesma trava do evento (lockEvent acima).
      const max = t.event.maxTicketsPerAccount;
      if (
        max != null &&
        (await ticketsHeldByAccount(tx, recipient.id, t.eventId, now)) + 1 > max
      ) {
        throw new AppError(
          "LIMIT_EXCEEDED",
          `Você já tem o máximo de ${max} ingresso(s) por conta para este evento.`,
        );
      }

      const toName = current.toHolderName ?? user.name;
      const oldToken = t.validationToken;
      // Condicional, como o check-in: só um VALID do mesmo titular muda de mãos.
      const { count } = await tx.issuedTicket.updateMany({
        where: {
          id: t.id,
          status: "VALID",
          holderUserId: current.fromUserId,
          validationToken: oldToken,
        },
        data: {
          holderUserId: recipient.id,
          holderName: toName,
          holderEmail: user.email,
          validationToken: randomToken(32),
        },
      });
      if (count !== 1)
        throw invalidState("Este ingresso não pode mais ser transferido.");
      await tx.ticketTransfer.update({
        where: { id: current.id },
        data: {
          status: "ACCEPTED",
          toUserId: recipient.id,
          toHolderName: toName,
          previousTokenHash: hashToken(oldToken),
          decidedAt: now,
          decidedById: recipient.id,
          decisionIp: m.ip,
          decisionUserAgent: m.userAgent,
        },
      });
      await audit(tx, {
        actorUserId: recipient.id,
        organizationId: t.event.organizationId,
        action: "ticket.transfer.accepted",
        entityType: "TicketTransfer",
        entityId: current.id,
        metadata: {
          ticketId: t.id,
          fromUserId: current.fromUserId,
          toUserId: recipient.id,
        },
      });
      for (const [index, message] of acceptedEmails({
        ticketCode: t.code,
        event: t.event,
        toEmail: user.email,
        toName,
        fromEmail: current.fromHolderEmail,
        fromName: current.fromHolderName,
      }).entries()) {
        await enqueueEmail(tx, {
          dedupeKey: `transfer-accepted:${current.id}:${index}`,
          template: "TRANSFER_ACCEPTED",
          recipient: message.to,
          message,
        });
      }
      return { expired: false, ticket: t };
    },
    TX_OPTIONS,
  );

  if (outcome.expired)
    throw invalidState(
      "Esta transferência expirou. Peça ao titular para enviar de novo.",
    );
  const { ticket } = outcome;
  kickEmailWorker(db);
  return { ticketCode: ticket.code };
}

async function decide(
  db: Db,
  transferId: string,
  where: Prisma.TicketTransferWhereInput,
  actorId: string,
  reason: string,
  action: string,
  decisionMeta?: RequestMeta,
  now = new Date(),
) {
  const m = meta(decisionMeta);
  // Atualização condicional: um aceite concorrente segura a linha (FOR UPDATE) e,
  // ao terminar, esta atualização não encontra mais status PENDING.
  const { count } = await db.ticketTransfer.updateMany({
    where: { ...where, id: transferId, status: "PENDING" },
    data: {
      status: "CANCELLED",
      decidedAt: now,
      decidedById: actorId,
      decisionReason: reason,
      decisionIp: m.ip,
      decisionUserAgent: m.userAgent,
    },
  });
  if (!count) throw invalidState("Esta transferência não está mais pendente.");
  const row = await db.ticketTransfer.findUniqueOrThrow({
    where: { id: transferId },
    select: { ticketId: true, event: { select: { organizationId: true } } },
  });
  await audit(db, {
    actorUserId: actorId,
    organizationId: row.event.organizationId,
    action,
    entityType: "TicketTransfer",
    entityId: transferId,
    metadata: { ticketId: row.ticketId },
  });
}

/** O titular desiste de uma transferência ainda não aceita. */
export async function cancelTransfer(
  db: Db,
  holder: Actor,
  transferId: string,
  decisionMeta?: RequestMeta,
  now = new Date(),
): Promise<void> {
  assertActive(holder);
  const transfer = await db.ticketTransfer.findUnique({
    where: { id: transferId },
    select: { fromUserId: true },
  });
  if (!transfer || transfer.fromUserId !== holder.id)
    throw notFound("Transferência não encontrada.");
  await decide(
    db,
    transferId,
    { fromUserId: holder.id },
    holder.id,
    "Cancelada pelo titular",
    "ticket.transfer.cancelled",
    decisionMeta,
    now,
  );
}

/** O destinatário recusa (status CANCELLED, decidida por ele). */
export async function declineTransfer(
  db: Db,
  recipient: Actor,
  token: RecipientTransferRef,
  decisionMeta?: RequestMeta,
  now = new Date(),
): Promise<void> {
  const { transfer } = await pendingForRecipient(db, recipient, token);
  await decide(
    db,
    transfer.id,
    {},
    recipient.id,
    DECLINED_BY_RECIPIENT,
    "ticket.transfer.declined",
    decisionMeta,
    now,
  );
}

/** Cron de manutenção: expira convites vencidos. decidedById nulo = expiração automática. */
export async function expireTicketTransfers(
  db: Db,
  at?: Date,
): Promise<number> {
  const events = await db.event.findMany({
    where: { transfers: { some: { status: "PENDING" } } },
    select: { id: true },
  });
  let expired = 0;
  for (const event of events) {
    expired += await db.$transaction(async (tx) => {
      // Convites antigos também seguem o corte atual após migração/remarcação. A trava
      // mantém o cron na mesma ordem das alterações de evento e dos aceites.
      await lockEvent(tx, event.id);
      const now = at ?? new Date();
      const current = await tx.event.findUniqueOrThrow({
        where: { id: event.id },
        select: {
          startsAt: true,
          transferDeadlineHours: true,
          transferMaxTransfers: true,
          transferAllowReturn: true,
        },
      });
      const deadlineReached =
        transferCutoff(current.startsAt, current).getTime() <= now.getTime();
      const { count } = await tx.ticketTransfer.updateMany({
        where: {
          eventId: event.id,
          status: "PENDING",
          ...(deadlineReached ? {} : { expiresAt: { lte: now } }),
        },
        data: { status: "EXPIRED", decidedAt: now },
      });
      return count;
    }, TX_OPTIONS);
  }
  return expired;
}

/** Transferências do titular (enviadas) e para o e-mail da conta (recebidas), para a UI da Fase 4. */
export async function listMyTransfers(db: Db, actor: Actor) {
  assertActive(actor);
  const user = await db.user.findUniqueOrThrow({
    where: { id: actor.id },
    select: { email: true, emailVerifiedAt: true },
  });
  const select = {
    id: true,
    status: true,
    fromHolderName: true,
    toEmail: true,
    toHolderName: true,
    createdAt: true,
    expiresAt: true,
    decidedAt: true,
    ticket: {
      select: { id: true, code: true, ticketType: { select: { name: true } } },
    },
    event: {
      select: {
        id: true,
        title: true,
        startsAt: true,
        timezone: true,
        transferDeadlineHours: true,
        transferMaxTransfers: true,
        transferAllowReturn: true,
      },
    },
  } satisfies Prisma.TicketTransferSelect;
  const [sent, received] = await Promise.all([
    db.ticketTransfer.findMany({
      where: { fromUserId: actor.id, initiatedBy: "HOLDER" },
      select: select,
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.ticketTransfer.findMany({
      where: {
        OR: [
          { toUserId: actor.id },
          ...(user.emailVerifiedAt
            ? [
                {
                  toEmail: user.email.toLowerCase(),
                  status: "PENDING" as const,
                },
              ]
            : []),
        ],
      },
      select: select,
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  // Mantém a validade histórica, mas fornece o corte efetivo para a interface não
  // oferecer um convite cuja política atual já encerrou (antes mesmo do próximo cron).
  const withEffectiveExpiry = (row: (typeof sent)[number]) => ({
    ...row,
    effectiveExpiresAt: row.expiresAt
      ? new Date(
          Math.min(
            row.expiresAt.getTime(),
            transferCutoff(row.event.startsAt, row.event).getTime(),
          ),
        )
      : null,
  });
  return {
    sent: sent.map(withEffectiveExpiry),
    received: received.map(withEffectiveExpiry),
  };
}

// ───────────────────────────── E-mails ─────────────────────────────
// Persistência na transação; transporte após commit e com retentativa pelo worker.
function kickEmailWorker(db: Db) {
  if (env().NODE_ENV === "test") return;
  void dispatchEmailOutbox(db).catch(() =>
    console.error("[transferência] fila de e-mail aguarda nova tentativa."),
  );
}

type EventInfo = { title: string; startsAt: Date; timezone: string };

function transferInviteEmail(p: {
  to: string;
  toName: string;
  fromName: string;
  token: string;
  expiresAt: Date;
  event: EventInfo;
}) {
  const url = `${env().APP_URL}/transferencia/${p.token}`;
  const when = formatEventDateTime(p.event.startsAt, p.event.timezone);
  const until = formatEventDateTime(p.expiresAt, p.event.timezone);
  return {
    to: p.to,
    subject: `${p.fromName} transferiu um ingresso para você: ${p.event.title}`,
    html: `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#14112b">
<h1 style="color:#312e81">Você recebeu um ingresso</h1>
<p>Olá, ${escapeHtml(p.toName)}. <strong>${escapeHtml(p.fromName)}</strong> quer transferir um ingresso para você.</p>
<p><strong>${escapeHtml(p.event.title)}</strong><br>${escapeHtml(when)}</p>
<p><a href="${url}">Ver e aceitar a transferência</a> (válido até ${escapeHtml(until)}). Entre com a conta deste e-mail; se ainda não tem, crie uma com ele. A transferência é gratuita.</p>
<p>Se você não esperava este e-mail, ignore-o.</p>
</body></html>`,
    text: `${p.fromName} quer transferir um ingresso para você.\n${p.event.title}\n${when}\nAceite até ${until}: ${url}`,
  };
}

function acceptedEmails(p: {
  ticketCode: string;
  event: EventInfo;
  toEmail: string;
  toName: string;
  fromEmail: string;
  fromName: string;
}) {
  const ticketUrl = `${env().APP_URL}/ingressos/${p.ticketCode}`;
  const title = escapeHtml(p.event.title);
  return [
    {
      to: p.toEmail,
      subject: `O ingresso agora é seu: ${p.event.title}`,
      html: `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#14112b">
<h1 style="color:#312e81">Transferência concluída</h1>
<p>O ingresso de <strong>${title}</strong> está na sua conta. <a href="${ticketUrl}">Abra o ingresso</a> para ver o QR code.</p>
</body></html>`,
      text: `O ingresso de ${p.event.title} está na sua conta: ${ticketUrl}`,
    },
    {
      to: p.fromEmail,
      subject: `Transferência aceita: ${p.event.title}`,
      html: `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#14112b">
<h1 style="color:#312e81">Transferência aceita</h1>
<p>Olá, ${escapeHtml(p.fromName)}. ${escapeHtml(p.toName)} aceitou o ingresso de <strong>${title}</strong>.</p>
<p>O QR code, o PDF e os passes de carteira que você tinha deste ingresso <strong>não valem mais</strong> na entrada.</p>
</body></html>`,
      text: `${p.toName} aceitou o ingresso de ${p.event.title}. O QR code anterior não vale mais.`,
    },
  ];
}
