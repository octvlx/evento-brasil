// Job agendado (ex.: a cada minuto): expira reservas vencidas, encerra eventos
// finalizados, reconcilia pagamentos/reembolsos com o provedor e verifica os
// invariantes financeiros. Protegido por segredo no header x-cron-secret.
import { db } from "@/server/db";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { getPaymentAdapter } from "@/server/payments";
import { completeEndedEvents } from "@/server/services/events";
import { expireStaleOrders } from "@/server/services/orders";
import { financeLog } from "@/server/services/finance-log";
import { checkFinancialInvariants, reconcilePayments } from "@/server/services/reconciliation";

export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(secret, env().CRON_SECRET)) return new Response("forbidden", { status: 403 });
  const expiredOrders = await expireStaleOrders(db);
  const completedEvents = await completeEndedEvents(db);
  const reconciliation = await reconcilePayments(db, getPaymentAdapter());
  const violations = await checkFinancialInvariants(db);
  if (violations.length) {
    // Incidente: nunca corrigir automaticamente — registrar para análise humana.
    console.error("[financeiro] violações de invariantes:", JSON.stringify(violations));
  }
  for (const e of reconciliation.errors) {
    financeLog("error", `reconciliation.${e.kind}_failed`, { orderId: e.orderId }, { entityId: e.id, message: e.message });
  }
  return Response.json({
    expiredOrders,
    completedEvents,
    reconciliation: { ...reconciliation, errors: reconciliation.errors.length },
    invariantViolations: violations.map((v) => ({ code: v.code, count: v.ids.length })),
    at: new Date().toISOString(),
  });
}
