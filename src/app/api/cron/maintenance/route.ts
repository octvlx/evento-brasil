// Job agendado (ex.: a cada minuto): expira reservas vencidas e convites de
// transferência de ingresso vencidos, encerra eventos finalizados, registra a
// liberação da cota de meia-entrada (L7c), reconcilia pagamentos/reembolsos com o
// provedor e verifica os invariantes financeiros e, no máximo uma vez por hora,
// expurga dados pessoais vencidos (prazos provisórios em src/server/retention.ts).
// Protegido por segredo no header x-cron-secret.
// Cada etapa é idempotente e isolada: a falha de uma é registrada e não impede as
// demais; a resposta sai com 500 para o agendador alertar. Nada aqui é a única
// proteção: o término do evento já é reconhecido pelo relógio em todo o backend.
import { dispatchEmailOutbox } from "@/server/email/outbox";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { getPaymentAdapter } from "@/server/payments";
import { completeEndedEvents } from "@/server/services/events";
import { recordHalfPriceReleases } from "@/server/services/half-price";
import { expireStaleOrders } from "@/server/services/orders";
import { financeLog } from "@/server/services/finance-log";
import { checkFinancialInvariants, reconcilePayments } from "@/server/services/reconciliation";
import { runRetentionPurgeIfDue } from "@/server/services/retention-purge";
import { expireTicketTransfers } from "@/server/services/transfers";

export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(secret, env().CRON_SECRET)) return new Response("forbidden", { status: 403 });
  const failed: string[] = [];
  // Só o nome da etapa e a mensagem do erro vão para o log (nunca headers ou segredos).
  const step = async <T,>(name: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      failed.push(name);
      console.error(`[cron] ${JSON.stringify({ step: name, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() })}`);
      return null;
    }
  };

  const expiredOrders = await step("expireStaleOrders", () => expireStaleOrders(db));
  const completedEvents = await step("completeEndedEvents", () => completeEndedEvents(db));
  // Só registra a liberação da cota de meia (auditoria); a regra já vale pelo relógio.
  const halfPriceReleases = await step("recordHalfPriceReleases", () => recordHalfPriceReleases(db));
  const expiredTransfers = await step("expireTicketTransfers", () => expireTicketTransfers(db));
  const reconciliation = await step("reconcilePayments", () => reconcilePayments(db, getPaymentAdapter()));
  const violations = (await step("checkFinancialInvariants", () => checkFinancialInvariants(db))) ?? [];
  if (violations.length) {
    // Incidente: nunca corrigir automaticamente — registrar para análise humana.
    console.error("[financeiro] violações de invariantes:", JSON.stringify(violations));
  }
  for (const e of reconciliation?.errors ?? []) {
    financeLog("error", `reconciliation.${e.kind}_failed`, { orderId: e.orderId }, { entityId: e.id, message: e.message });
  }
  const emailDelivery = await step("dispatchEmailOutbox", () => dispatchEmailOutbox(db));
  const retention = await step("runRetentionPurgeIfDue", () => runRetentionPurgeIfDue(db));
  return Response.json(
    {
      emailDelivery,
      expiredOrders,
      completedEvents,
      halfPriceReleases,
      expiredTransfers,
      reconciliation: reconciliation && { ...reconciliation, errors: reconciliation.errors.length },
      retention,
      invariantViolations: violations.map((v) => ({ code: v.code, count: v.ids.length })),
      failedSteps: failed,
      at: new Date().toISOString(),
    },
    { status: failed.length ? 500 : 200 },
  );
}
