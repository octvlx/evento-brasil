// Alertas de segurança: eventos que hoje só ficam no AuditLog e que alguém precisa
// saber na hora. São sinais de ataque ou de abuso, ou ações que mudam quem manda.
// Rodado pelo cron de manutenção (a cada minuto), logo depois da saúde operacional.
//
// Diferente de ops-health (estado que persiste), aqui são acontecimentos. Conta o que
// aconteceu na hora corrente (UTC) e avisa ALERT_EMAILS no máximo uma vez por hora e
// por tipo. O e-mail leva só contagens, nunca e-mail, IP ou nome: os detalhes ficam
// na auditoria do /admin. Também não entra em GET /api/cron/health: uma conta
// bloqueada não é o site fora do ar.
import "server-only";
import type { Db } from "../db";
import { raiseOperationalAlerts, type AlertDelivery, type HealthCheck } from "./ops-health";

export const SECURITY_ALERT_WINDOW_HOURS = 1;

/** Abaixo destes valores o reembolso é rotina (pedido do comprador dentro da política). */
export const SECURITY_THRESHOLDS = {
  /** Um reembolso a partir deste valor (R$ 2.000) chama atenção sozinho. */
  largeRefundCents: 200_000,
  /** Reembolsos na mesma hora (fora cancelamento de evento) a partir deste número... */
  refundSpikeCount: 20,
  /** ...ou desta soma (R$ 10.000). */
  refundSpikeCents: 1_000_000,
};
export type SecurityThresholds = typeof SECURITY_THRESHOLDS;

type AuditAlert = Omit<HealthCheck, "count" | "oldestAt"> & { actions: string[] };

/** Ações do AuditLog que viram alerta. `auth.login_locked` é gravado por login-limits.ts. */
export const SECURITY_AUDIT_ALERTS: AuditAlert[] = [
  {
    code: "MFA_USER_LOCKED",
    severity: "critical",
    actions: ["mfa.user_locked"],
    title: "Contas com a verificação em duas etapas travada: senha certa e muitos códigos errados (senha provavelmente vazada)",
    href: "/admin/auditoria?acao=mfa.user_locked",
  },
  {
    code: "ADMIN_ROLES_CHANGED",
    severity: "critical",
    actions: ["admin.roles_changed", "admin.bootstrap"],
    title: "Papéis de administrador alterados",
    href: "/admin/auditoria?acao=admin.",
  },
  {
    code: "ACCOUNT_LOGIN_LOCKED",
    severity: "warning",
    actions: ["auth.login_locked"],
    title: "Contas bloqueadas por muitas senhas erradas",
    href: "/admin/auditoria?acao=auth.login_locked",
  },
  {
    code: "ADMIN_SENSITIVE_ACTION",
    severity: "warning",
    actions: ["mfa.reset_by_admin", "user.deleted_by_admin", "organization.deleted", "commission_rule.created", "commission_rule.updated", "commission_rule.deleted"],
    title: "Ações administrativas sensíveis: 2FA redefinido, conta ou organização apagada, comissão alterada",
    href: "/admin/auditoria",
  },
];

/** Início da hora corrente (UTC): a mesma janela da deduplicação do e-mail. */
export function securityWindowStart(now: Date): Date {
  const size = SECURITY_ALERT_WINDOW_HOURS * 3_600_000;
  return new Date(Math.floor(now.getTime() / size) * size);
}

/** O que aconteceu na hora corrente e merece aviso. Lista vazia = nada. */
export async function securityAlerts(db: Db, now = new Date(), thresholds: SecurityThresholds = SECURITY_THRESHOLDS): Promise<HealthCheck[]> {
  const since = securityWindowStart(now);
  const actions = SECURITY_AUDIT_ALERTS.flatMap((a) => a.actions);
  // Cancelamento de evento reembolsa todo mundo de uma vez: é decisão registrada, não anomalia.
  const refundWhere = { createdAt: { gte: since, lte: now }, reason: { not: "EVENT_CANCELLED" as const } };
  const [audits, large, byAdmin, all] = await Promise.all([
    db.auditLog.groupBy({
      by: ["action"],
      where: { action: { in: actions }, createdAt: { gte: since, lte: now } },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    db.refund.aggregate({ where: { ...refundWhere, amountCents: { gte: thresholds.largeRefundCents } }, _count: { _all: true }, _min: { createdAt: true } }),
    db.refund.aggregate({ where: { ...refundWhere, reason: "ADMIN" }, _count: { _all: true }, _min: { createdAt: true } }),
    db.refund.aggregate({ where: refundWhere, _count: { _all: true }, _sum: { amountCents: true }, _min: { createdAt: true } }),
  ]);

  const checks: HealthCheck[] = [];
  for (const { actions: group, ...alert } of SECURITY_AUDIT_ALERTS) {
    const rows = audits.filter((r) => group.includes(r.action));
    const count = rows.reduce((sum, r) => sum + r._count._all, 0);
    const oldestAt = rows.reduce<Date | null>((min, r) => (r._min.createdAt && (!min || r._min.createdAt < min) ? r._min.createdAt : min), null);
    if (count > 0) checks.push({ ...alert, count, oldestAt });
  }
  const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const spikeSum = all._sum.amountCents ?? 0;
  if (all._count._all >= thresholds.refundSpikeCount || spikeSum >= thresholds.refundSpikeCents) {
    checks.push({
      code: "REFUND_SPIKE",
      severity: "critical",
      title: `Volume de reembolsos fora do padrão nesta hora (${brl(spikeSum)} no total, fora cancelamento de evento)`,
      count: all._count._all,
      oldestAt: all._min.createdAt,
      href: "/admin/pagamentos",
    });
  }
  if (large._count._all > 0) {
    checks.push({
      code: "REFUND_LARGE",
      severity: "warning",
      title: `Reembolsos a partir de ${brl(thresholds.largeRefundCents)} cada`,
      count: large._count._all,
      oldestAt: large._min.createdAt,
      href: "/admin/pagamentos",
    });
  }
  if (byAdmin._count._all > 0) {
    checks.push({
      code: "REFUND_BY_ADMIN",
      severity: "warning",
      title: "Reembolsos feitos manualmente por administrador (fora do pedido do comprador)",
      count: byAdmin._count._all,
      oldestAt: byAdmin._min.createdAt,
      href: "/admin/pagamentos",
    });
  }
  return checks;
}

const SECURITY_DELIVERY: AlertDelivery = {
  repeatHours: SECURITY_ALERT_WINDOW_HOURS,
  kind: "security-alert",
  template: "SECURITY_ALERT",
  footer: "A contagem é desta hora (UTC). Os detalhes estão na auditoria do admin. Se houver novos casos, chega outro aviso na próxima hora.",
};

/** Log e e-mail para ALERT_EMAILS, no máximo um por tipo e hora. */
export function raiseSecurityAlerts(db: Db, checks: HealthCheck[], now = new Date()) {
  return raiseOperationalAlerts(db, checks, now, SECURITY_DELIVERY);
}
