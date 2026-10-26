// Log estruturado da área financeira: uma linha JSON por evento, sempre com o
// id do pedido como correlation id quando conhecido, para cruzar cron, webhook,
// reembolso e auditoria do mesmo pedido.
import "server-only";

export interface FinanceLogContext {
  orderId?: string | null;
  refundId?: string | null;
  paymentId?: string | null;
  providerPaymentId?: string | null;
}

export function financeLog(level: "error" | "warn" | "info", event: string, ctx: FinanceLogContext, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({ area: "financeiro", event, correlationId: ctx.orderId ?? null, ...ctx, ...details, at: new Date().toISOString() });
  console[level](`[financeiro] ${line}`);
}
