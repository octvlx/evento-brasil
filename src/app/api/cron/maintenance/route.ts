// Job agendado (ex.: a cada minuto): expira reservas vencidas e convites de
// transferência de ingresso vencidos, encerra eventos
// finalizados, reconcilia pagamentos/reembolsos com o provedor e verifica os
// invariantes financeiros. Protegido por segredo no header x-cron-secret.
import { dispatchEmailOutbox } from "@/server/email/outbox";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { getPaymentAdapter } from "@/server/payments";
import { completeEndedEvents } from "@/server/services/events";
import { expireStaleOrders } from "@/server/services/orders";
import { financeLog } from "@/server/services/finance-log";
import { checkFinancialInvariants, reconcilePayments } from "@/server/services/reconciliation";
import { expireTicketTransfers } from "@/server/services/transfers";

export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(secret, env().CRON_SECRET)) return new Response("forbidden", { status: 403 });
  const expiredOrders = await expireStaleOrders(db);
  const completedEvents = await completeEndedEvents(db);
  const expiredTransfers = await expireTicketTransfers(db);
  const reconciliation = await reconcilePayments(db, getPaymentAdapter());
  const violations = await checkFinancialInvariants(db);
  if (violations.length) {
    // Incidente: nunca corrigir automaticamente — registrar para análise humana.
    console.error("[financeiro] violações de invariantes:", JSON.stringify(violations));
  }
  for (const e of reconciliation.errors) {
    financeLog("error", `reconciliation.${e.kind}_failed`, { orderId: e.orderId }, { entityId: e.id, message: e.message });
  }
  const emailDelivery = await dispatchEmailOutbox(db);
  return Response.json({
    emailDelivery,
    expiredOrders,
    completedEvents,
    expiredTransfers,
    reconciliation: { ...reconciliation, errors: reconciliation.errors.length },
    invariantViolations: violations.map((v) => ({ code: v.code, count: v.ids.length })),
    at: new Date().toISOString(),
  });
}
