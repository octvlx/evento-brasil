// Saúde operacional: o que precisa de alguém olhar e que, sem alerta, só aparece se
// um admin abrir /admin/pagamentos. Rodado pelo cron de manutenção (a cada minuto),
// pela home do /admin e por GET /api/cron/health (monitor externo).
//
// Cada problema gera: um log de erro/aviso sempre, e um e-mail para ALERT_EMAILS
// (se configurado) no máximo uma vez a cada ALERT_REPEAT_HOURS por problema,
// enquanto ele persistir. Nada aqui corrige dado: só avisa.
import "server-only";
import type { Db } from "../db";
import { enqueueEmail } from "../email/outbox";
import { transactionalEmail } from "../email/templates";
import { env } from "../env";
import { logEvent } from "../log";
import { AWAITING_REFUND_WHERE, refundRetryStates } from "./refunds";

export type HealthSeverity = "critical" | "warning";

export interface HealthCheck {
  code: string;
  severity: HealthSeverity;
  /** Texto para pessoas (admin e e-mail). */
  title: string;
  count: number;
  /** Desde quando o item mais antigo está nessa situação. */
  oldestAt: Date | null;
  /** Onde resolver, no admin. */
  href: string;
}

/** Limites: abaixo deles o fluxo normal (retentativa, reconciliação) ainda costuma resolver. */
export const HEALTH_THRESHOLDS = {
  webhookStuckMinutes: 15,
  refundProcessingStuckMinutes: 60,
  emailFailureWindowHours: 24,
} as const;

export const ALERT_REPEAT_HOURS = 6;

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

/** Problemas abertos agora. Lista vazia = tudo certo. `invariantViolations` vem do cron. */
export async function operationalHealth(db: Db, now = new Date(), invariantViolations: { code: string; ids: string[] }[] = []): Promise<HealthCheck[]> {
  const T = HEALTH_THRESHOLDS;
  const [webhooks, failedRefunds, processing, flagged, emails] = await Promise.all([
    db.paymentWebhookEvent.aggregate({
      where: { processedAt: null, receivedAt: { lte: minutesAgo(now, T.webhookStuckMinutes) } },
      _count: { _all: true },
      _min: { receivedAt: true },
    }),
    db.refund.findMany({
      where: AWAITING_REFUND_WHERE,
      select: { id: true, note: true, updatedAt: true },
    }),
    db.refund.aggregate({
      where: { status: "PROCESSING", updatedAt: { lte: minutesAgo(now, T.refundProcessingStuckMinutes) } },
      _count: { _all: true },
      _min: { updatedAt: true },
    }),
    db.payment.aggregate({
      where: { failureReason: { in: ["AMOUNT_MISMATCH", "DUPLICATE_PAYMENT_REQUIRES_REFUND"] }, status: "PAID" },
      _count: { _all: true },
      _min: { updatedAt: true },
    }),
    db.emailOutbox.aggregate({
      where: { status: { in: ["FAILED", "UNKNOWN"] }, updatedAt: { gte: minutesAgo(now, T.emailFailureWindowHours * 60) } },
      _count: { _all: true },
      _min: { updatedAt: true },
    }),
  ]);
  const states = await refundRetryStates(db, failedRefunds);
  const awaiting = failedRefunds.filter((r) => states.get(r.id)?.awaitingAdminDecision);

  const checks: HealthCheck[] = [];
  const add = (c: HealthCheck) => c.count > 0 && checks.push(c);
  add({
    code: "INVARIANT_VIOLATION",
    severity: "critical",
    title: "Invariantes financeiros violados (razão, estoque ou reembolso inconsistentes)",
    count: invariantViolations.reduce((s, v) => s + v.ids.length, 0),
    oldestAt: null,
    href: "/admin/pagamentos",
  });
  add({
    code: "REFUND_AWAITING_ADMIN",
    severity: "critical",
    title: "Reembolsos com falha aguardando decisão do admin (comprador sem ingresso e sem dinheiro)",
    count: awaiting.length,
    oldestAt: awaiting.reduce<Date | null>((min, r) => (!min || r.updatedAt < min ? r.updatedAt : min), null),
    href: "/admin/pagamentos",
  });
  add({
    code: "WEBHOOK_STUCK",
    severity: "critical",
    title: `Webhooks de pagamento sem processar há mais de ${T.webhookStuckMinutes} min`,
    count: webhooks._count._all,
    oldestAt: webhooks._min.receivedAt,
    href: "/admin/pagamentos",
  });
  add({
    code: "PAYMENT_NEEDS_MANUAL_REFUND",
    severity: "critical",
    title: "Pagamentos duplicados ou com valor divergente esperando reembolso manual",
    count: flagged._count._all,
    oldestAt: flagged._min.updatedAt,
    href: "/admin/pagamentos",
  });
  add({
    code: "REFUND_STUCK_PROCESSING",
    severity: "warning",
    title: `Reembolsos em processamento há mais de ${T.refundProcessingStuckMinutes} min`,
    count: processing._count._all,
    oldestAt: processing._min.updatedAt,
    href: "/admin/pagamentos",
  });
  add({
    code: "EMAIL_DELIVERY_FAILED",
    severity: "warning",
    title: `E-mails que falharam nas últimas ${T.emailFailureWindowHours} h`,
    count: emails._count._all,
    oldestAt: emails._min.updatedAt,
    href: "/admin",
  });
  return checks;
}

/** Destinatários de alerta (ALERT_EMAILS, separados por vírgula). */
export function alertRecipients(): string[] {
  return (env().ALERT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

/**
 * Registra cada problema no log e enfileira o e-mail de alerta. A chave de
 * deduplicação inclui a janela de ALERT_REPEAT_HOURS: o mesmo problema avisa de novo
 * só na janela seguinte, enquanto persistir. Devolve quantos e-mails entraram na fila
 * (os já enfileirados na janela não contam).
 */
export async function raiseOperationalAlerts(db: Db, checks: HealthCheck[], now = new Date()): Promise<{ problems: number; queued: number }> {
  const window = Math.floor(now.getTime() / (ALERT_REPEAT_HOURS * 3_600_000));
  const to = alertRecipients();
  let queued = 0;
  for (const c of checks) {
    logEvent(c.severity === "critical" ? "error" : "warn", "alerta", c.code, { count: c.count, oldestAt: c.oldestAt?.toISOString() ?? null });
    for (const recipient of to) {
      const dedupeKey = `ops-alert:${c.code}:${window}:${recipient}`;
      const existed = await db.emailOutbox.findUnique({ where: { dedupeKey }, select: { id: true } });
      if (existed) continue;
      await enqueueEmail(db, {
        dedupeKey,
        template: "OPS_ALERT",
        recipient,
        message: {
          ...transactionalEmail(
            "event",
            (c.severity === "critical" ? "Alerta: " : "Atenção: ") + c.title,
            [
              `Quantidade: ${c.count}`,
              ...(c.oldestAt ? [`Mais antigo desde: ${c.oldestAt.toISOString()} (UTC)`] : []),
              `Código: ${c.code}`,
              `Enquanto o problema continuar, este aviso se repete a cada ${ALERT_REPEAT_HOURS} h.`,
            ],
            env().APP_URL + c.href,
          ),
          subject: `[${c.severity === "critical" ? "ALERTA" : "atenção"}] ${c.title}`,
        },
        // Alerta velho não ajuda: se não sair na janela, é descartado.
        expiresAt: new Date((window + 1) * ALERT_REPEAT_HOURS * 3_600_000),
      });
      queued++;
    }
  }
  return { problems: checks.length, queued };
}
