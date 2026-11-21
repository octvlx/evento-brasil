import "server-only";
import type { CommissionRule, CommissionScope, FeeBearer, ProcessingFeeBearer } from "@/generated/prisma/client";
import { computeFees } from "@/features/fees/policy";
import type { Db, Tx } from "../db";
import { audit } from "../audit";
import { type Actor, assertAdminPermission } from "../auth/permissions";
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

/** Regra de plataforma vigente (padrão para quem não tem regra própria). Só leitura, para a página pública de taxas. */
export async function currentPlatformCommissionRule(client: Db | Tx, at = new Date()): Promise<CommissionRule | null> {
  return client.commissionRule.findFirst({
    where: { scope: "PLATFORM", activeFrom: { lte: at }, OR: [{ activeTo: null }, { activeTo: { gt: at } }] },
    orderBy: { activeFrom: "desc" },
  });
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
export function buyerPricePreview(
  rule: Pick<CommissionRule, "percentBps" | "fixedCentsPerTicket" | "bearer">,
  priceCents: number,
  halfPrice = false,
): BuyerPricePreview {
  const [line] = computeFees([{ ticketTypeId: "preview", unitPriceCents: priceCents, quantity: 1, halfPrice }], { ...rule, policyVersion: "preview" }).lines;
  return { priceCents, serviceFeeCents: line.serviceFeePerUnitCents, totalCents: priceCents + line.serviceFeePerUnitCents };
}

/**
 * A comissão volta para o comprador no reembolso? No split do Mercado Pago, sim, sempre: o
 * estorno devolve a comissão da conta da plataforma, proporcionalmente, e o site não tem como
 * cobrá-la do organizador depois. Só o provedor simulado consegue reter a comissão, então só
 * nele `refundCommissionOnRefund = false` vale; com pagamento real o razão segue o provedor.
 */
export function commissionReturnedOnRefund(rule: { refundCommissionOnRefund: boolean } | null | undefined, isSimulated: boolean) {
  return isSimulated ? (rule?.refundCommissionOnRefund ?? true) : true;
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
  /** false: o valor fixo por ingresso não volta ao comprador (ver retainedFixedFeeCents). */
  fixedFeeRefundable?: boolean;
}

export type RuleValues = Omit<NewRuleInput, "scope" | "organizationId" | "eventId">;

/** Próximo número de versão do alvo: maior número já usado + 1 (versões excluídas não voltam). */
async function nextVersionNumber(tx: Tx, target: { scope: CommissionScope; organizationId: string | null; eventId: string | null }) {
  const rows = await tx.commissionRule.findMany({ where: target, select: { policyVersion: true } });
  return rows.reduce((max, r) => Math.max(max, Number(/:v(\d+)$/.exec(r.policyVersion)?.[1] ?? 0)), 0) + 1;
}

/** Nova versão de regra: encerra a vigente do mesmo escopo/alvo e cria outra. Regras antigas permanecem. */
export async function setCommissionRule(db: Db, actor: Actor, input: NewRuleInput): Promise<CommissionRule> {
  assertAdminPermission(actor, "finance:commissions");
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
    const version = await nextVersionNumber(tx, target);
    const suffix = target.eventId ?? target.organizationId ?? "default";
    const rule = await tx.commissionRule.create({
      data: {
        ...target,
        percentBps: input.percentBps,
        fixedCentsPerTicket: input.fixedCentsPerTicket,
        bearer: input.bearer,
        processingFeeBearer: input.processingFeeBearer,
        refundCommissionOnRefund: input.refundCommissionOnRefund,
        fixedFeeRefundable: input.fixedFeeRefundable ?? true,
        policyVersion: `${input.scope.toLowerCase()}:${suffix}:v${version}`,
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

const RULE_VALUE_FIELDS = ["percentBps", "fixedCentsPerTicket", "bearer", "processingFeeBearer", "refundCommissionOnRefund", "fixedFeeRefundable"] as const;

/**
 * Trava a versão e confere que nenhum pedido a usa. Pedido guarda os valores calculados e
 * aponta para a versão (Order.commissionRuleId, ON DELETE RESTRICT): versão em uso não muda
 * nem some; para mudar valores daqui em diante, cria-se uma nova versão.
 */
async function lockUnusedRule(tx: Tx, ruleId: string) {
  await tx.$queryRaw`SELECT id FROM "CommissionRule" WHERE id = ${ruleId} FOR UPDATE`;
  const rule = await tx.commissionRule.findUnique({ where: { id: ruleId } });
  if (!rule) throw new AppError("NOT_FOUND", "Versão de regra não encontrada.");
  const orders = await tx.order.count({ where: { commissionRuleId: ruleId } });
  if (orders) {
    throw new AppError("CONFLICT", `Esta versão já foi usada em ${orders} ${orders === 1 ? "pedido" : "pedidos"} e não pode ser alterada nem excluída. Crie uma nova versão.`);
  }
  return rule;
}

/** Corrige os valores de uma versão que nenhum pedido usou (ex.: criada com valor errado). */
export async function updateCommissionRule(db: Db, actor: Actor, ruleId: string, values: RuleValues): Promise<CommissionRule> {
  assertAdminPermission(actor, "finance:commissions");
  return db.$transaction(async (tx) => {
    const before = await lockUnusedRule(tx, ruleId);
    const data = Object.fromEntries(RULE_VALUE_FIELDS.map((k) => [k, values[k]])) as RuleValues;
    const rule = await tx.commissionRule.update({ where: { id: ruleId }, data });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: before.organizationId,
      action: "commission_rule.updated",
      entityType: "CommissionRule",
      entityId: ruleId,
      metadata: { policyVersion: before.policyVersion, before: Object.fromEntries(RULE_VALUE_FIELDS.map((k) => [k, before[k]])), after: { ...data } },
    });
    return rule;
  });
}

/**
 * Exclui uma versão que nenhum pedido usou. Sendo a vigente, a versão anterior do mesmo
 * alvo (a que ela encerrou) volta a valer. A plataforma nunca fica sem regra vigente.
 */
export async function deleteCommissionRule(db: Db, actor: Actor, ruleId: string) {
  assertAdminPermission(actor, "finance:commissions");
  return db.$transaction(async (tx) => {
    const rule = await lockUnusedRule(tx, ruleId);
    const target = { scope: rule.scope, organizationId: rule.organizationId, eventId: rule.eventId };
    let reactivated: CommissionRule | null = null;
    if (!rule.activeTo) {
      const previous = await tx.commissionRule.findFirst({ where: { ...target, activeTo: rule.activeFrom, NOT: { id: rule.id } }, orderBy: { activeFrom: "desc" } });
      if (!previous && rule.scope === "PLATFORM") {
        throw new AppError("INVALID_STATE", "A plataforma precisa de uma regra vigente. Crie outra versão antes de excluir esta.");
      }
      if (previous) reactivated = await tx.commissionRule.update({ where: { id: previous.id }, data: { activeTo: null } });
    }
    await tx.commissionRule.delete({ where: { id: rule.id } });
    await audit(tx, {
      actorUserId: actor.id,
      organizationId: rule.organizationId,
      action: "commission_rule.deleted",
      entityType: "CommissionRule",
      entityId: rule.id,
      metadata: {
        policyVersion: rule.policyVersion,
        values: Object.fromEntries(RULE_VALUE_FIELDS.map((k) => [k, rule[k]])),
        ...(reactivated ? { reactivated: reactivated.policyVersion } : {}),
      },
    });
    return { reactivated: reactivated?.policyVersion ?? null };
  });
}
