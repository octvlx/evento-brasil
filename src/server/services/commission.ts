import "server-only";
import type { CommissionRule, CommissionScope, FeeBearer, ProcessingFeeBearer } from "@/generated/prisma/client";
import { computeFees } from "@/features/fees/policy";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { assertPlatformAdmin, type Actor } from "../auth/permissions";
import { AppError } from "../errors";

export const DEFAULT_COMMISSION_BPS = 700; // 7% do valor de face

/** Regra vigente mais específica: evento → organização → plataforma. */
export async function resolveCommissionRule(client: Db | Tx, organizationId: string, eventId: string, at = new Date()): Promise<CommissionRule> {
  return (await resolveCommissionRules(client, [{ id: eventId, organizationId }], at)).get(eventId)!;
}

/** Mesma precedência do checkout, em uma consulta para toda a vitrine. */
export async function resolveCommissionRules(client: Db | Tx, events: { id: string; organizationId: string }[], at = new Date()): Promise<Map<string, CommissionRule>> {
  if (!events.length) return new Map();
  const active = { activeFrom: { lte: at }, OR: [{ activeTo: null }, { activeTo: { gt: at } }] };
  const rules = await client.commissionRule.findMany({
    where: {
      AND: [
        active,
        { OR: [{ scope: "EVENT", eventId: { in: [...new Set(events.map((event) => event.id))] } }, { scope: "ORGANIZATION", organizationId: { in: [...new Set(events.map((event) => event.organizationId))] } }, { scope: "PLATFORM" }] },
      ],
    },
    orderBy: { activeFrom: "desc" },
  });
  const eventRules = new Map<string, CommissionRule>();
  const orgRules = new Map<string, CommissionRule>();
  let platformRule: CommissionRule | undefined;
  for (const rule of rules) {
    if (rule.scope === "EVENT" && rule.eventId && !eventRules.has(rule.eventId)) eventRules.set(rule.eventId, rule);
    if (rule.scope === "ORGANIZATION" && rule.organizationId && !orgRules.has(rule.organizationId)) orgRules.set(rule.organizationId, rule);
    if (rule.scope === "PLATFORM" && !platformRule) platformRule = rule;
  }
  return new Map(events.map((event) => {
    const rule = eventRules.get(event.id) ?? orgRules.get(event.organizationId) ?? platformRule;
    if (!rule) throw new AppError("INVALID_STATE", "Nenhuma regra de comissão configurada para a plataforma.");
    return [event.id, rule];
  }));
}

export interface BuyerPricePreview {
  priceCents: number;
  /** Taxa de serviço por ingresso (0 quando a comissão sai do repasse do organizador). */
  serviceFeeCents: number;
  /** O que o comprador paga por ingresso: preço + taxa de serviço. */
  totalCents: number;
}

/**
 * Prévia do preço por ingresso para o catálogo (Decreto 13.108, R1). Usa o
 * mesmo `computeFees` do `createOrder`, então o valor exibido é o cobrado
 * (coberto por tests/integration/r-price-preview.test.ts). A regra vem de
 * `resolveCommissionRule` para o evento.
 */
export function buyerPricePreview(rule: Pick<CommissionRule, "percentBps" | "fixedCentsPerTicket" | "bearer">, priceCents: number): BuyerPricePreview {
  const [line] = computeFees([{ ticketTypeId: "preview", unitPriceCents: priceCents, quantity: 1 }], { ...rule, policyVersion: "preview" }).lines;
  return { priceCents, serviceFeeCents: line.serviceFeePerUnitCents, totalCents: priceCents + line.serviceFeePerUnitCents };
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
