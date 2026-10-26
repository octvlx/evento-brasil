import "server-only";
import type { CommissionRule, CommissionScope, FeeBearer, ProcessingFeeBearer } from "@/generated/prisma/client";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { assertPlatformAdmin, type Actor } from "../auth/permissions";
import { AppError } from "../errors";

export const DEFAULT_COMMISSION_BPS = 700; // 7% do valor de face

/** Regra vigente mais específica: evento → organização → plataforma. */
export async function resolveCommissionRule(client: Db | Tx, organizationId: string, eventId: string, at = new Date()): Promise<CommissionRule> {
  const active = { activeFrom: { lte: at }, OR: [{ activeTo: null }, { activeTo: { gt: at } }] };
  const rules = await client.commissionRule.findMany({
    where: {
      AND: [
        active,
        { OR: [{ scope: "EVENT", eventId }, { scope: "ORGANIZATION", organizationId }, { scope: "PLATFORM" }] },
      ],
    },
    orderBy: { activeFrom: "desc" },
  });
  const pick = (s: CommissionScope) => rules.find((r) => r.scope === s);
  const rule = pick("EVENT") ?? pick("ORGANIZATION") ?? pick("PLATFORM");
  if (!rule) throw new AppError("INVALID_STATE", "Nenhuma regra de comissão configurada para a plataforma.");
  return rule;
}

export interface NewRuleInput {
  scope: CommissionScope;
  organizationId?: string;
  eventId?: string;
  percentBps: number;
  fixedCentsPerTicket: number;
  bearer: FeeBearer;
  processingFeeBearer: ProcessingFeeBearer;
  refundCommissionOnRefund: boolean;
}

/** Nova versão de regra: encerra a vigente do mesmo escopo/alvo e cria outra. Regras antigas permanecem. */
export async function setCommissionRule(db: Db, actor: Actor, input: NewRuleInput): Promise<CommissionRule> {
  assertPlatformAdmin(actor);
  if (input.scope === "EVENT" && !input.eventId) throw new AppError("VALIDATION", "Informe o evento.");
  if (input.scope === "ORGANIZATION" && !input.organizationId) throw new AppError("VALIDATION", "Informe a organização.");
  const target = {
    scope: input.scope,
    organizationId: input.scope === "ORGANIZATION" ? input.organizationId! : null,
    eventId: input.scope === "EVENT" ? input.eventId! : null,
  };
  return db.$transaction(async (tx) => {
    const now = new Date();
    await tx.commissionRule.updateMany({ where: { ...target, activeTo: null }, data: { activeTo: now } });
    const count = await tx.commissionRule.count({ where: target });
    const suffix = target.eventId ?? target.organizationId ?? "default";
    const rule = await tx.commissionRule.create({
      data: {
        ...target,
        percentBps: input.percentBps,
        fixedCentsPerTicket: input.fixedCentsPerTicket,
        bearer: input.bearer,
        processingFeeBearer: input.processingFeeBearer,
        refundCommissionOnRefund: input.refundCommissionOnRefund,
        policyVersion: `${input.scope.toLowerCase()}:${suffix}:v${count + 1}`,
        activeFrom: now,
        createdById: actor.id,
      },
    });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: target.organizationId,
      action: "commission_rule.created",
      entityType: "CommissionRule",
      entityId: rule.id,
      metadata: { ...input },
    });
    return rule;
  });
}
