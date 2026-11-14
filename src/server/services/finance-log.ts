// Log estruturado da área financeira: uma linha JSON por evento, sempre com o
// id do pedido como correlation id quando conhecido, para cruzar cron, webhook,
// reembolso e auditoria do mesmo pedido.
import "server-only";
import { logEvent } from "../log";

export interface FinanceLogContext {
  orderId?: string | null;
  refundId?: string | null;
  paymentId?: string | null;
  providerPaymentId?: string | null;
}

export function financeLog(level: "error" | "warn" | "info", event: string, ctx: FinanceLogContext, details: Record<string, unknown> = {}) {
  logEvent(level, "financeiro", event, { correlationId: ctx.orderId ?? null, ...ctx, ...details });
}
