import "server-only";
import { DATA_STEPS, isDataStep, type DataStep, type WizardStep } from "@/features/organizer/wizard-steps";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import type { Actor } from "../auth/permissions";

// Progresso do assistente de criação de evento (etapas concluídas e a última
// acessada). Sem coluna própria no schema, fica no AuditLog como uma linha
// `event.wizard_progress` por mudança — a mais recente vale. Proposta para o
// `banco-de-dados` (colunas em Event) em docs/areas/organizador.md; trocar a
// fonte é só neste arquivo.

export const WIZARD_PROGRESS_ACTION = "event.wizard_progress";

export interface WizardProgress {
  /** Evento criado pelo assistente (eventos antigos não têm progresso). */
  tracked: boolean;
  completed: DataStep[];
  lastStep: WizardStep | null;
}

const UNTRACKED: WizardProgress = {
  tracked: false,
  completed: [],
  lastStep: null,
};

function parse(metadata: unknown): WizardProgress {
  const m = (metadata ?? {}) as { completed?: unknown; lastStep?: unknown };
  const completed = Array.isArray(m.completed) ? DATA_STEPS.filter((s) => (m.completed as unknown[]).includes(s)) : [];
  const last = Number(m.lastStep);
  return {
    tracked: true,
    completed,
    lastStep: Number.isInteger(last) && last >= 1 && last <= 6 ? (last as WizardStep) : null,
  };
}

export async function getWizardProgress(client: Db | Tx, eventId: string): Promise<WizardProgress> {
  const row = await client.auditLog.findFirst({
    where: {
      entityType: "Event",
      entityId: eventId,
      action: WIZARD_PROGRESS_ACTION,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { metadata: true },
  });
  return row ? parse(row.metadata) : UNTRACKED;
}

/** Progresso de vários eventos (lista do painel). */
export async function wizardProgressByEvent(client: Db | Tx, eventIds: string[]): Promise<Map<string, WizardProgress>> {
  const out = new Map<string, WizardProgress>();
  if (!eventIds.length) return out;
  const rows = await client.auditLog.findMany({
    where: {
      entityType: "Event",
      entityId: { in: eventIds },
      action: WIZARD_PROGRESS_ACTION,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { entityId: true, metadata: true },
  });
  for (const r of rows) if (!out.has(r.entityId)) out.set(r.entityId, parse(r.metadata));
  return out;
}

export function isWizardComplete(p: WizardProgress) {
  return !p.tracked || DATA_STEPS.every((s) => p.completed.includes(s));
}

/** Grava uma nova linha só quando algo muda (concluir etapa ou trocar de etapa). */
export async function recordWizardProgress(client: Db | Tx, actor: Actor, organizationId: string, eventId: string, patch: { complete?: DataStep; lastStep?: WizardStep }): Promise<WizardProgress> {
  const current = await getWizardProgress(client, eventId);
  const completed = patch.complete && !current.completed.includes(patch.complete) ? [...current.completed, patch.complete].sort() : current.completed;
  const lastStep = patch.lastStep ?? current.lastStep;
  const next: WizardProgress = {
    tracked: true,
    completed: completed.filter(isDataStep),
    lastStep,
  };
  if (current.tracked && completed === current.completed && lastStep === current.lastStep) return current;
  await audit(client, {
    actorUserId: actor.id,
    organizationId,
    action: WIZARD_PROGRESS_ACTION,
    entityType: "Event",
    entityId: eventId,
    metadata: { completed: next.completed, lastStep: next.lastStep },
  });
  return next;
}
