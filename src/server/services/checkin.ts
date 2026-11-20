import "server-only";
import type { CheckinResult, EventStatus, OfflineDivergence, TicketKind } from "@/generated/prisma/client";
import { CHECKIN_GRACE_MS, checkinNotYetOpen, checkinOpensAt, checkinWindowOpen, MAX_CHECKIN_OPENS_MINUTES } from "@/lib/event-lifecycle";
import { formatDateTimeShort } from "@/lib/datetime";
import { audit } from "../audit";
import { assertEventPermission, roleHas } from "../auth/permissions";
import { TX_OPTIONS, type Db, type Tx } from "../db";
import { resolveCheckinAccess, type Actor } from "../auth/permissions";
import { hashToken, qrTokenHash } from "../crypto";
import { AppError, forbidden, notFound } from "../errors";
import { parseQrPayload } from "@/lib/qr-payload";

export interface CheckinResponse {
  result: CheckinResult;
  message: string;
  // ticketKind permite à portaria exigir o documento da meia-entrada (HALF_PRICE).
  // Ausente, como o resto de `ticket`, em leituras de ingresso de outra organização.
  // transferred: o ingresso mudou de titular por transferência aceita (R6); holderName é
  // o titular atual. qrReplaced: o QR lido é o anterior a uma transferência (resultado
  // INVALID) — só informado para a mesma organização do evento.
  // simulated: ingresso de pedido com pagamento simulado (provedor de testes) — a portaria vê "TESTE".
  ticket?: { code: string; holderName: string | null; ticketTypeName: string; ticketKind: TicketKind; checkedInAt: Date | null; transferred: boolean; qrReplaced?: true; simulated?: boolean };
  counters: { admitted: number; total: number };
  /** Portaria ainda fechada: quando abre (ISO). */
  opensAt?: string;
  /** Só em leitura offline sincronizada: o aparelho e o servidor discordaram. */
  divergence?: OfflineDivergence;
}

const MESSAGES: Record<CheckinResult, string> = {
  ADMITTED: "Entrada liberada",
  DUPLICATE: "Ingresso JÁ UTILIZADO",
  WRONG_EVENT: "Ingresso de OUTRO evento",
  REVOKED: "Ingresso CANCELADO/REEMBOLSADO",
  INVALID: "QR code inválido",
  EVENT_NOT_ACTIVE: "Evento não está ativo para check-in",
};

async function counters(db: Db, eventId: string) {
  const rows = await db.issuedTicket.groupBy({ by: ["status"], where: { eventId }, _count: { _all: true } });
  const of = (status: string) => rows.find((r) => r.status === status)?._count._all ?? 0;
  const admitted = of("CHECKED_IN");
  return { admitted, total: admitted + of("VALID") };
}

// Travas na MESMA ordem do restante do app (cancellation/refunds/payments/orders):
// Event → Order → ingressos. FOR KEY SHARE não bloqueia outras leituras de check-in
// (nem UPDATEs que não mexem na chave), mas espera quem segura FOR UPDATE — ou seja,
// cancelamento, reembolso e chargeback — e impede que eles comecem no meio da leitura.
async function lockEventForCheckin(tx: Tx, eventId: string) {
  const rows = await tx.$queryRaw<{ status: EventStatus; startsAt: Date; endsAt: Date; checkinOpensMinutesBefore: number; timezone: string; organizationId: string }[]>`
    SELECT status, "startsAt", "endsAt", "checkinOpensMinutesBefore", timezone, "organizationId" FROM "Event" WHERE id = ${eventId} FOR KEY SHARE`;
  if (!rows[0]) throw notFound("Evento não encontrado.");
  const r = rows[0];
  return { ...r, startsAt: new Date(r.startsAt), endsAt: new Date(r.endsAt), checkinOpensMinutesBefore: Number(r.checkinOpensMinutesBefore) };
}

/**
 * Trava compartilhada da organização do evento, ANTES do evento. Mudanças de equipe
 * (papel, remoção, atribuição por evento) e de status da organização travam a mesma
 * linha em modo exclusivo: uma leitura nunca admite com uma permissão que já foi
 * retirada, e a retirada espera as leituras em curso. FOR SHARE não bloqueia outras
 * leituras. Ordem: Organization → Event (a mesma de quem trava os dois).
 */
async function lockOrganizationForCheckin(tx: Tx, eventId: string) {
  const event = await tx.event.findUnique({ where: { id: eventId }, select: { organizationId: true } });
  if (!event) throw forbidden();
  await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${event.organizationId} FOR SHARE`;
}

async function lockOrderForCheckin(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT status FROM "Order" WHERE id = ${orderId} FOR KEY SHARE`;
}

const ticketForView = { ticketType: { select: { name: true, kind: true } }, event: { select: { organizationId: true } }, order: { select: { isSimulated: true } } } as const;

async function wasTransferred(tx: Tx, ticketId: string) {
  return !!(await tx.ticketTransfer.findFirst({ where: { ticketId, status: "ACCEPTED" }, select: { id: true } }));
}

/**
 * QR anterior a uma transferência aceita deste evento (o aceite sobe a versão do token e
 * guarda o hash do antigo). Só para a portaria da organização do evento: devolve o
 * ingresso com o titular atual; de outra organização, nada.
 */
async function replacedByTransfer(tx: Tx, eventId: string, organizationId: string, parsed: { code: string; token: string }) {
  const transfer = await tx.ticketTransfer.findFirst({
    where: { eventId, status: "ACCEPTED", previousTokenHash: hashToken(parsed.token) },
    select: { ticket: { include: ticketForView } },
  });
  const t = transfer?.ticket;
  if (!t || t.code !== parsed.code || t.event.organizationId !== organizationId) return null;
  return t;
}

/**
 * Validação 100% online e atômica: só uma leitura pode transicionar VALID → CHECKED_IN,
 * e a transição e o registro da leitura (TicketCheckin) são gravados na mesma transação.
 */
export async function checkInTicket(
  db: Db,
  actor: Actor,
  eventId: string,
  rawPayload: string,
  now = new Date(),
  // localResult (só offline): o que o aparelho mostrou na porta, enviado na sincronização.
  opts: { offline?: boolean; skipCounters?: boolean; localResult?: CheckinResult } = {},
): Promise<CheckinResponse> {
  const local = opts.offline ? opts.localResult : undefined;
  // Divergência entre o aparelho offline e o servidor, gravada junto com a leitura.
  let divergence: OfflineDivergence | undefined;

  const outcome = await db.$transaction(
    async (tx): Promise<{ result: CheckinResult; ticket?: CheckinResponse["ticket"]; opensAt?: Date; timezone?: string }> => {
      const record = (result: CheckinResult, ticketId: string | null, refusedButValid = false) => {
        divergence = refusedButValid ? "REFUSED_BUT_VALID" : local === "ADMITTED" && result !== "ADMITTED" ? "ADMITTED_BUT_REJECTED" : undefined;
        return tx.ticketCheckin.create({
          data: { eventId, ticketId, scannedById: actor.id, result, scannedAt: now, offline: opts.offline === true, offlineLocalResult: local ?? null, divergence: divergence ?? null },
        });
      };

      // 0. Permissão conferida sob a trava da organização, na mesma transação da entrada.
      await lockOrganizationForCheckin(tx, eventId);
      await resolveCheckinAccess(tx, actor, eventId);

      // 1. Evento (trava compartilhada) e janela de check-in.
      const event = await lockEventForCheckin(tx, eventId);
      // Pelo relógio: encerrado comercialmente (com ou sem o job) ainda aceita entrada
      // por 12 h; depois disso, fecha mesmo que o status no banco siga PUBLISHED.
      if (!checkinWindowOpen(event, now)) {
        await record("EVENT_NOT_ACTIVE", null);
        // Antes da abertura configurada pelo organizador: diz quando abre.
        return checkinNotYetOpen(event, now) ? { result: "EVENT_NOT_ACTIVE", opensAt: checkinOpensAt(event), timezone: event.timezone } : { result: "EVENT_NOT_ACTIVE" };
      }

      // 2. QR → ingresso (busca pelo token; o código precisa bater).
      const parsed = parseQrPayload(rawPayload);
      const ticket = parsed
        ? await tx.issuedTicket.findUnique({ where: { validationTokenHash: qrTokenHash(parsed.token) }, include: ticketForView })
        : null;
      if (!parsed || !ticket || ticket.code !== parsed.code) {
        // QR antigo de ingresso transferido: continua INVALID, mas a portaria do
        // organizador vê que foi substituído e quem é o titular atual.
        const replaced = parsed && !ticket ? await replacedByTransfer(tx, eventId, event.organizationId, parsed) : null;
        await record("INVALID", replaced?.id ?? null);
        if (!replaced) return { result: "INVALID" };
        return {
          result: "INVALID",
          ticket: { code: replaced.code, holderName: replaced.holderName, ticketTypeName: replaced.ticketType.name, ticketKind: replaced.ticketType.kind, checkedInAt: replaced.checkedInAt, transferred: true, qrReplaced: true },
        };
      }
      // Só consultado quando o ingresso vai aparecer na tela (mesma organização).
      const transferred = ticket.event.organizationId === event.organizationId ? await wasTransferred(tx, ticket.id) : false;
      const view = (checkedInAt: Date | null) => ({ code: ticket.code, holderName: ticket.holderName, ticketTypeName: ticket.ticketType.name, ticketKind: ticket.ticketType.kind, checkedInAt, transferred, simulated: ticket.order.isSimulated });

      if (ticket.eventId !== eventId) {
        // Ingresso de outra organização: a leitura não é vinculada ao ingresso nem revela
        // o titular (o histórico desta organização não pode expor dados de compradores alheios).
        if (ticket.event.organizationId !== event.organizationId) {
          await record("WRONG_EVENT", null);
          return { result: "WRONG_EVENT" };
        }
        await record("WRONG_EVENT", ticket.id);
        return { result: "WRONG_EVENT", ticket: view(null) };
      }

      // 3. Pedido (trava compartilhada, mesma ordem de reembolso/chargeback).
      await lockOrderForCheckin(tx, ticket.orderId);

      // 4. Transição condicional VALID → CHECKED_IN.
      if (ticket.status === "REVOKED") {
        await record("REVOKED", ticket.id);
        return { result: "REVOKED", ticket: view(null) };
      }
      // Recusado na porta sem internet: a pessoa não entrou, então a sincronização não dá
      // entrada agora (senão o ingresso viraria "JÁ UTILIZADO" quando ela voltar). Registra a
      // recusa que aconteceu e marca a divergência para o organizador conferir.
      if (local && local !== "ADMITTED" && ticket.status === "VALID") {
        await record(local, ticket.id, true);
        return { result: local, ticket: view(null) };
      }
      // O token entra no WHERE: se uma transferência aceita trocou o QR depois da busca
      // acima, o QR antigo não admite (defesa extra; o aceite já espera a trava do evento).
      const { count } = await tx.issuedTicket.updateMany({
        where: { id: ticket.id, status: "VALID", validationTokenHash: ticket.validationTokenHash },
        // Usado: o QR não volta a ser exibido, então o token antigo (versão 0) sai do banco.
        data: { status: "CHECKED_IN", checkedInAt: now, legacyValidationToken: null },
      });
      if (count === 1) {
        await record("ADMITTED", ticket.id);
        return { result: "ADMITTED", ticket: view(now) };
      }
      const current = await tx.issuedTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      if (current.validationTokenHash !== ticket.validationTokenHash) {
        await record("INVALID", null);
        return { result: "INVALID" };
      }
      const result: CheckinResult = current.status === "REVOKED" ? "REVOKED" : "DUPLICATE";
      await record(result, ticket.id);
      return { result, ticket: view(current.checkedInAt) };
    },
    { ...TX_OPTIONS, isolationLevel: "ReadCommitted" },
  );

  // Contadores fora da transação, após o commit.
  const message =
    divergence === "REFUSED_BUT_VALID"
      ? "Recusado sem internet, mas o ingresso é válido: continua sem entrada"
      : outcome.ticket?.qrReplaced
        ? "QR SUBSTITUÍDO — ingresso transferido"
        : outcome.opensAt
          ? `Check-in ainda não abriu: abre ${formatDateTimeShort(outcome.opensAt, outcome.timezone)}`
          : MESSAGES[outcome.result];
  return {
    result: outcome.result,
    message,
    ticket: outcome.ticket,
    divergence,
    ...(outcome.opensAt ? { opensAt: outcome.opensAt.toISOString() } : {}),
    counters: opts.skipCounters ? { admitted: 0, total: 0 } : await counters(db, eventId),
  };
}

// ---------------------------------------------------------------------------
// Check-in offline
// ---------------------------------------------------------------------------

/** Validade da lista baixada: depois disso o aparelho não valida offline (precisa baixar de novo). */
export const OFFLINE_PACKAGE_TTL_MS = 12 * 3600_000;
/** Leituras por sincronização. */
export const OFFLINE_SYNC_MAX = 500;
/** Hora informada pelo aparelho: aceita até 24 h no passado; fora disso vale a hora do servidor. */
const OFFLINE_MAX_AGE_MS = 24 * 3600_000;

/** SHA-256 (hex) do token do QR: é o que a lista offline guarda, nunca o token (o mesmo hash do banco). */
export const offlineTokenHash = qrTokenHash;

export interface OfflinePackage {
  eventId: string;
  generatedAt: string;
  validUntil: string;
  /** Abertura da portaria (ISO): antes disso o aparelho também recusa. Ausente em listas antigas. */
  opensAt?: string;
  tickets: { h: string; code: string; status: "VALID" | "CHECKED_IN" | "REVOKED"; holderName: string | null; ticketTypeName: string; ticketKind: TicketKind; sim?: boolean }[];
}

/**
 * Lista para validar sem internet: só o hash do token de cada ingresso do evento (o QR
 * não pode ser recriado a partir dela), a situação no momento do download e o que a
 * portaria já vê online (titular e tipo). Mesmas permissões do leitor.
 */
export async function checkinOfflinePackage(db: Db, actor: Actor, eventId: string, now = new Date()): Promise<OfflinePackage> {
  await resolveCheckinAccess(db, actor, eventId);
  const event = await db.event.findUnique({ where: { id: eventId }, select: { status: true, startsAt: true, endsAt: true, checkinOpensMinutesBefore: true, timezone: true } });
  // A lista pode ser baixada antes da abertura (preparação dos aparelhos), desde que a
  // portaria abra dentro da validade dela; o aparelho só libera a partir da abertura.
  const opensAt = event ? checkinOpensAt(event) : null;
  const usable = event && (checkinWindowOpen(event, now) || (checkinNotYetOpen(event, now) && opensAt!.getTime() - now.getTime() < OFFLINE_PACKAGE_TTL_MS));
  if (!event || !usable) {
    const when = event && opensAt && checkinNotYetOpen(event, now) ? ` A portaria abre ${formatDateTimeShort(opensAt, event.timezone)}; baixe a lista nas 12 horas anteriores.` : "";
    throw new AppError("INVALID_STATE", `O check-in deste evento não está aberto: não há lista para baixar.${when}`);
  }
  const rows = await db.issuedTicket.findMany({
    where: { eventId },
    select: { code: true, validationTokenHash: true, status: true, holderName: true, ticketType: { select: { name: true, kind: true } }, order: { select: { isSimulated: true } } },
  });
  return {
    eventId,
    generatedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + OFFLINE_PACKAGE_TTL_MS).toISOString(),
    opensAt: opensAt!.toISOString(),
    tickets: rows.map((t) => ({
      h: t.validationTokenHash,
      code: t.code,
      status: t.status,
      holderName: t.holderName,
      ticketTypeName: t.ticketType.name,
      ticketKind: t.ticketType.kind,
      ...(t.order.isSimulated ? { sim: true } : {}),
    })),
  };
}

export interface OfflineEntry {
  payload: string;
  scannedAt: string;
  /** O que o aparelho mostrou na hora (sem internet). */
  localResult: CheckinResult;
}

export interface OfflineSyncItem {
  payload: string;
  localResult: CheckinResult;
  result: CheckinResult;
  message: string;
  /** O aparelho liberou, mas o servidor não admitiu (ex.: já tinha entrado por outro aparelho). */
  conflict: boolean;
  /** Qualquer discordância entre aparelho e servidor (inclui a recusa de um ingresso válido). */
  divergence?: OfflineDivergence;
  code?: string;
  holderName?: string | null;
}

/**
 * Envia as leituras feitas sem internet, na ordem, pelo MESMO checkInTicket atômico do
 * check-in online: o servidor decide. Um ingresso liberado em dois aparelhos offline só
 * conta uma entrada; a outra volta como conflito para a portaria conferir.
 */
export async function syncOfflineCheckins(db: Db, actor: Actor, eventId: string, raw: unknown, now = new Date()): Promise<{ items: OfflineSyncItem[]; counters: { admitted: number; total: number } }> {
  await resolveCheckinAccess(db, actor, eventId);
  if (!Array.isArray(raw) || raw.length === 0) throw new AppError("VALIDATION", "Nenhuma leitura para sincronizar.");
  if (raw.length > OFFLINE_SYNC_MAX) throw new AppError("VALIDATION", `Envie no máximo ${OFFLINE_SYNC_MAX} leituras por vez.`);
  const results = new Set<string>(Object.keys(MESSAGES));
  const items: OfflineSyncItem[] = [];
  for (const e of raw as Partial<OfflineEntry>[]) {
    const payload = typeof e?.payload === "string" ? e.payload.slice(0, 200) : "";
    const localResult = (typeof e?.localResult === "string" && results.has(e.localResult) ? e.localResult : "INVALID") as CheckinResult;
    const t = typeof e?.scannedAt === "string" ? new Date(e.scannedAt) : new Date(NaN);
    const at = Number.isFinite(t.getTime()) && t.getTime() <= now.getTime() && now.getTime() - t.getTime() <= OFFLINE_MAX_AGE_MS ? t : now;
    const r = await checkInTicket(db, actor, eventId, payload, at, { offline: true, skipCounters: true, localResult });
    items.push({ payload, localResult, result: r.result, message: r.message, conflict: r.divergence === "ADMITTED_BUT_REJECTED", divergence: r.divergence, code: r.ticket?.code, holderName: r.ticket?.holderName });
  }
  return { items, counters: await counters(db, eventId) };
}

export async function checkinHistory(db: Db, actor: Actor, eventId: string, limit = 50) {
  const { canSeeAllHistory } = await resolveCheckinAccess(db, actor, eventId);
  return db.ticketCheckin.findMany({
    where: { eventId, ...(canSeeAllHistory ? {} : { scannedById: actor.id }) },
    include: { ticket: { select: { code: true, holderName: true } }, scannedBy: { select: { name: true } } },
    orderBy: { scannedAt: "desc" },
    take: limit,
  });
}

export interface OfflineDivergenceRow {
  id: string;
  scannedAt: Date;
  divergence: OfflineDivergence;
  localResult: CheckinResult | null;
  result: CheckinResult;
  scannedBy: string;
  ticket: { code: string; holderName: string | null; status: "VALID" | "CHECKED_IN" | "REVOKED"; checkedInAt: Date | null } | null;
}

/**
 * Leituras offline em que o aparelho e o servidor discordaram, para o organizador conferir
 * (mais recentes primeiro, 50 por página). Só para quem vê o histórico completo do check-in do evento.
 */
export async function listOfflineDivergences(
  db: Db,
  actor: Actor,
  eventId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ rows: OfflineDivergenceRow[]; total: number; admittedButRejected: number; page: number; pageCount: number }> {
  const { canSeeAllHistory } = await resolveCheckinAccess(db, actor, eventId);
  if (!canSeeAllHistory) throw forbidden();
  const pageSize = opts.pageSize ?? 50;
  const where = { eventId, divergence: { not: null } } as const;
  const [total, admittedButRejected] = await Promise.all([
    db.ticketCheckin.count({ where }),
    db.ticketCheckin.count({ where: { eventId, divergence: "ADMITTED_BUT_REJECTED" } }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);
  const rows = await db.ticketCheckin.findMany({
    where,
    select: {
      id: true,
      scannedAt: true,
      divergence: true,
      offlineLocalResult: true,
      result: true,
      scannedBy: { select: { name: true } },
      ticket: { select: { code: true, holderName: true, status: true, checkedInAt: true } },
    },
    orderBy: [{ scannedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return {
    rows: rows.map((r) => ({ id: r.id, scannedAt: r.scannedAt, divergence: r.divergence!, localResult: r.offlineLocalResult, result: r.result, scannedBy: r.scannedBy.name, ticket: r.ticket })),
    total,
    admittedButRejected,
    page,
    pageCount,
  };
}

// ---------------------------------------------------------------------------
// Configuração da portaria e histórico completo
// ---------------------------------------------------------------------------

/**
 * Eventos da lista /check-in (até 12 h após o término): todos os da organização para
 * quem vê o histórico completo (dono, admin, gestor de eventos); para a equipe de
 * portaria, só os atribuídos e enquanto o papel ainda permitir ler QR — as mesmas
 * regras de resolveCheckinAccess.
 */
export async function listCheckinEvents(db: Db, userId: string, now = new Date()) {
  const memberships = await db.organizationMember.findMany({ where: { userId } });
  const fullAccessOrgs = memberships.filter((m) => roleHas(m.role, "checkin:history")).map((m) => m.organizationId);
  const scanOrgs = memberships.filter((m) => roleHas(m.role, "checkin:scan")).map((m) => m.organizationId);
  return db.event.findMany({
    where: {
      status: { in: ["PUBLISHED", "COMPLETED"] },
      endsAt: { gt: new Date(now.getTime() - CHECKIN_GRACE_MS) },
      OR: [{ organizationId: { in: fullAccessOrgs } }, { organizationId: { in: scanOrgs }, staffAssignments: { some: { userId } } }],
    },
    orderBy: { startsAt: "asc" },
    include: { organization: { select: { name: true } } },
  });
}

/** Quantos minutos antes do início a portaria abre (quem edita o evento). */
export async function setCheckinOpening(db: Db, actor: Actor, eventId: string, minutes: number) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_CHECKIN_OPENS_MINUTES)
    throw new AppError("VALIDATION", "Escolha uma abertura entre o horário do início e 7 dias antes.");
  return db.$transaction(async (tx) => {
    await assertEventPermission(tx, actor, eventId, "event:write");
    const [row] = await tx.$queryRaw<{ checkinOpensMinutesBefore: number; organizationId: string }[]>`
      SELECT "checkinOpensMinutesBefore", "organizationId" FROM "Event" WHERE id = ${eventId} FOR NO KEY UPDATE`;
    if (!row) throw notFound("Evento não encontrado.");
    const previous = Number(row.checkinOpensMinutesBefore);
    if (previous === minutes) return { minutes };
    await tx.event.update({ where: { id: eventId }, data: { checkinOpensMinutesBefore: minutes } });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: row.organizationId,
      action: "event.checkin_opening",
      entityType: "Event",
      entityId: eventId,
      metadata: { minutes, previous },
    });
    return { minutes };
  });
}

export const CHECKIN_RESULTS: readonly CheckinResult[] = ["ADMITTED", "DUPLICATE", "WRONG_EVENT", "REVOKED", "INVALID", "EVENT_NOT_ACTIVE"];

export interface CheckinHistoryFilters {
  result?: CheckinResult;
  offline?: boolean;
}

/** Filtros da URL (`resultado`, `origem` = online/offline); valores desconhecidos são ignorados. */
export function parseCheckinHistoryFilters(sp: Record<string, string | null | undefined>): CheckinHistoryFilters {
  const result = CHECKIN_RESULTS.includes(sp.resultado as CheckinResult) ? (sp.resultado as CheckinResult) : undefined;
  const offline = sp.origem === "offline" ? true : sp.origem === "online" ? false : undefined;
  return { result, offline };
}

/** Filtros → parâmetros de URL (links, paginação e CSV). */
export function checkinHistoryParams(f: CheckinHistoryFilters): { resultado?: string; origem?: string } {
  return { resultado: f.result, origem: f.offline === undefined ? undefined : f.offline ? "offline" : "online" };
}

function historyWhere(eventId: string, f: CheckinHistoryFilters) {
  return { eventId, ...(f.result ? { result: f.result } : {}), ...(f.offline !== undefined ? { offline: f.offline } : {}) };
}

/** Entradas por hora local do evento ("AAAA-MM-DD HH:00"), em ordem. */
export function admittedPerHour(times: Date[], timeZone: string): { hour: string; admitted: number }[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const counts = new Map<string, number>();
  for (const t of times) {
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    const key = `${p.year}-${p.month}-${p.day} ${p.hour}:00`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hour, admitted]) => ({ hour, admitted }));
}

/** Linhas por exportação do histórico. */
export const CHECKIN_EXPORT_LIMIT = 50_000;

/**
 * Histórico completo do evento (quem vê todas as leituras): página, filtros, totais por
 * resultado e entradas liberadas por hora (fuso do evento).
 */
export async function checkinHistoryReport(db: Db, actor: Actor, eventId: string, filters: CheckinHistoryFilters = {}, opts: { page?: number; pageSize?: number } = {}) {
  const { canSeeAllHistory } = await resolveCheckinAccess(db, actor, eventId);
  if (!canSeeAllHistory) throw forbidden();
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { timezone: true } });
  const pageSize = opts.pageSize ?? 50;
  const where = historyWhere(eventId, filters);
  const [total, byResult, hours] = await Promise.all([
    db.ticketCheckin.count({ where }),
    db.ticketCheckin.groupBy({ by: ["result"], where: { eventId }, _count: { _all: true } }),
    // Agrupado aqui, pelo horário que o Prisma devolve: conta de horário em SQL depende do
    // fuso da sessão do banco (o adaptador grava sem fuso).
    db.ticketCheckin.findMany({ where: { eventId, result: "ADMITTED" }, select: { scannedAt: true } }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(opts.page ?? 1) || 1), pageCount);
  const rows = await db.ticketCheckin.findMany({
    where,
    include: { ticket: { select: { code: true, holderName: true } }, scannedBy: { select: { name: true } } },
    orderBy: [{ scannedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  const counts = Object.fromEntries(CHECKIN_RESULTS.map((r) => [r, byResult.find((b) => b.result === r)?._count._all ?? 0])) as Record<CheckinResult, number>;
  const perHour = admittedPerHour(hours.map((h) => h.scannedAt), event.timezone);
  return { rows, total, page, pageCount, counts, perHour, timezone: event.timezone };
}

/** CSV do histórico com os filtros da tela; a exportação fica registrada. */
export async function exportCheckinHistory(db: Db, actor: Actor, eventId: string, filters: CheckinHistoryFilters = {}) {
  const { canSeeAllHistory } = await resolveCheckinAccess(db, actor, eventId);
  if (!canSeeAllHistory) throw forbidden();
  const event = await db.event.findUniqueOrThrow({ where: { id: eventId }, select: { timezone: true, organizationId: true, slug: true } });
  const rows = await db.ticketCheckin.findMany({
    where: historyWhere(eventId, filters),
    include: { ticket: { select: { code: true, holderName: true } }, scannedBy: { select: { name: true } } },
    orderBy: [{ scannedAt: "asc" }, { id: "asc" }],
    take: CHECKIN_EXPORT_LIMIT + 1,
  });
  const truncated = rows.length > CHECKIN_EXPORT_LIMIT;
  const items = truncated ? rows.slice(0, CHECKIN_EXPORT_LIMIT) : rows;
  await audit(db, {
    actorUserId: actor.id,
    organizationId: event.organizationId,
    action: "checkin.history_exported",
    entityType: "Event",
    entityId: eventId,
    metadata: { rows: items.length, truncated, result: filters.result ?? null, offline: filters.offline ?? null },
  });
  return { items, truncated, timezone: event.timezone, slug: event.slug };
}
