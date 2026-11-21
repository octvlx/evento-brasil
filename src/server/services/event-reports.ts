import "server-only";
import { z } from "zod";
import { Prisma, type EventReportReason } from "@/generated/prisma/client";
import type { Db } from "../db";
import { audit } from "../audit";
import { assertActive, assertAdminPermission, type Actor } from "../auth/permissions";
import { AppError, notFound } from "../errors";
import { rateLimit } from "../rate-limit";
import { EVENT_REPORT_REASONS } from "@/features/event-reports/labels";

// Denúncias de eventos: qualquer pessoa logada denuncia um evento público; a moderação
// (events:moderate) decide por evento. Suspender ou cancelar o evento continua nas
// ferramentas próprias (setEventSuspended, cancelamento): aqui só se registra a decisão.

export { EVENT_REPORT_REASONS };

/** Denúncias por pessoa por hora (todas as denúncias, de qualquer evento). */
export const REPORTS_PER_HOUR = 10;

export const eventReportInputSchema = z
  .object({
    reason: z.enum(Object.keys(EVENT_REPORT_REASONS) as [EventReportReason, ...EventReportReason[]], { message: "Escolha o motivo" }),
    details: z
      .string()
      .trim()
      .max(1000, "Use no máximo 1000 caracteres")
      .optional()
      .transform((v) => v || undefined),
  })
  .superRefine((v, ctx) => {
    if (v.reason === "OTHER" && !v.details) ctx.addIssue({ code: "custom", path: ["details"], message: "Conte o que aconteceu" });
  });
export type EventReportInput = z.input<typeof eventReportInputSchema>;

/**
 * Registra a denúncia. Só eventos que a página pública mostra (publicado/concluído, não
 * suspenso, organização aprovada). Membro da organização não denuncia o próprio evento.
 * Uma denúncia aberta por pessoa e evento (índice parcial): repetir responde CONFLICT.
 */
export async function reportEvent(db: Db, actor: Actor, eventId: string, raw: EventReportInput) {
  assertActive(actor);
  const parsed = eventReportInputSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Dados inválidos.");
  const input = parsed.data;
  const event = await db.event.findFirst({
    where: { id: eventId, status: { in: ["PUBLISHED", "COMPLETED"] }, suspendedAt: null, organization: { status: "APPROVED" } },
    select: { id: true, organizationId: true },
  });
  if (!event) throw notFound("Evento não encontrado.");
  const member = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: event.organizationId, userId: actor.id } }, select: { userId: true } });
  if (member) throw new AppError("FORBIDDEN", "Você faz parte da organização deste evento.");
  await rateLimit(`event-report:${actor.id}`, REPORTS_PER_HOUR, 3_600_000, db);
  try {
    return await db.$transaction(async (tx) => {
      const report = await tx.eventReport.create({ data: { eventId: event.id, reporterId: actor.id, reason: input.reason, details: input.details ?? null } });
      await audit(tx, { actorUserId: actor.id, organizationId: event.organizationId, action: "event.reported", entityType: "Event", entityId: event.id, metadata: { reportId: report.id, reason: input.reason } });
      return report;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError("CONFLICT", "Você já denunciou este evento. A equipe está analisando.");
    }
    throw err;
  }
}

export const REPORT_QUEUE_PAGE_SIZE = 20;

/**
 * Fila da moderação: eventos com denúncias abertas, os com mais denúncias primeiro
 * (empate: a denúncia mais antiga). Cada evento traz as denúncias abertas, sem dados
 * pessoais do denunciante além do nome (a moderação pode precisar contatar).
 */
export async function listOpenEventReports(db: Db, admin: Actor, page = 1) {
  assertAdminPermission(admin, "events:moderate");
  const groups = await db.eventReport.groupBy({
    by: ["eventId"],
    where: { status: "OPEN" },
    _count: { _all: true },
    _min: { createdAt: true },
  });
  groups.sort((a, b) => b._count._all - a._count._all || a._min.createdAt!.getTime() - b._min.createdAt!.getTime());
  const total = groups.length;
  const pageCount = Math.max(1, Math.ceil(total / REPORT_QUEUE_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const slice = groups.slice((current - 1) * REPORT_QUEUE_PAGE_SIZE, current * REPORT_QUEUE_PAGE_SIZE);
  const ids = slice.map((g) => g.eventId);
  const [events, reports] = await Promise.all([
    db.event.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, slug: true, status: true, suspendedAt: true, startsAt: true, timezone: true, organization: { select: { id: true, name: true, slug: true } } },
    }),
    db.eventReport.findMany({
      where: { eventId: { in: ids }, status: "OPEN" },
      select: { id: true, eventId: true, reason: true, details: true, createdAt: true, reporter: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const byId = new Map(events.map((e) => [e.id, e]));
  return {
    total,
    page: current,
    pageCount,
    items: slice.map((g) => ({ event: byId.get(g.eventId)!, count: g._count._all, oldestAt: g._min.createdAt!, reports: reports.filter((r) => r.eventId === g.eventId) })),
  };
}

export const decideEventReportsSchema = z
  .object({
    decision: z.enum(["RESOLVED", "DISMISSED"]),
    note: z
      .string()
      .trim()
      .max(1000, "Use no máximo 1000 caracteres")
      .optional()
      .transform((v) => v || undefined),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "RESOLVED" && !v.note) ctx.addIssue({ code: "custom", path: ["note"], message: "Descreva o que foi feito (ex.: evento suspenso, organizador contatado)" });
  });

/**
 * Decide todas as denúncias abertas do evento de uma vez. Só as que estavam abertas
 * mudam (updateMany com status OPEN): duas decisões simultâneas não se sobrepõem, e a
 * segunda responde CONFLICT. Denúncias abertas depois da decisão ficam para a próxima.
 */
export async function decideEventReports(db: Db, admin: Actor, eventId: string, raw: z.input<typeof decideEventReportsSchema>) {
  assertAdminPermission(admin, "events:moderate");
  const parsed = decideEventReportsSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Dados inválidos.");
  const { decision, note } = parsed.data;
  return db.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { id: true, organizationId: true } });
    if (!event) throw notFound("Evento não encontrado.");
    const now = new Date();
    const { count } = await tx.eventReport.updateMany({
      where: { eventId, status: "OPEN" },
      data: { status: decision, decidedById: admin.id, decidedAt: now, decisionNote: note ?? null },
    });
    if (!count) throw new AppError("CONFLICT", "Não há denúncias abertas para este evento (outra pessoa pode ter decidido agora).");
    await audit(tx, {
      actorUserId: admin.id,
      organizationId: event.organizationId,
      action: decision === "RESOLVED" ? "event.reports_resolved" : "event.reports_dismissed",
      entityType: "Event",
      entityId: eventId,
      metadata: { count, ...(note ? { note } : {}) },
    });
    return { count };
  });
}

/** Total de denúncias abertas (visão geral e saúde da operação). */
export function countOpenEventReports(db: Db) {
  return db.eventReport.count({ where: { status: "OPEN" } });
}
