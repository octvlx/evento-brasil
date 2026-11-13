"use server";

// Pedido de cancelamento com protocolo (R5). Contrato em docs/areas/financeiro.md.
// A tela do comprador fica na página do pedido; a fila do admin em /admin (Fase 4).

import { refresh } from "next/cache";
import { db } from "@/server/db";
import { dispatchEmailOutbox } from "@/server/email/outbox";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { requireAdmin, requireUser } from "@/server/auth/current";
import { getPaymentAdapter } from "@/server/payments";
import {
  createCancellationRequest,
  decideCancellationRequest,
  withdrawCancellationRequest,
  type CancellationOutcome,
} from "@/server/services/cancellation-requests";

// Protocolo e resposta saem na hora; o que falhar fica na fila para o cron.
function sendQueuedEmails() {
  if (process.env.NODE_ENV !== "test") void dispatchEmailOutbox(db, { limit: 5 }).catch(() => {});
}

export async function requestCancellationAction(orderId: string, reason: string): Promise<ActionResult<{ protocol: string; respondBy: Date | null }>> {
  const user = await requireUser(`/pedido/${orderId}`);
  const result = await toActionResult(async () => {
    const request = await createCancellationRequest(db, user, orderId, String(reason ?? ""));
    return { protocol: request.protocol, respondBy: request.respondBy };
  });
  if (result.ok) {
    sendQueuedEmails();
    refresh();
  }
  return result;
}

export async function withdrawCancellationAction(requestId: string): Promise<ActionResult<{ status: string }>> {
  const user = await requireUser();
  const result = await toActionResult(async () => ({ status: (await withdrawCancellationRequest(db, user, requestId)).status }));
  if (result.ok) refresh();
  return result;
}

export async function adminDecideCancellationAction(
  requestId: string,
  decision: "APPROVE" | "REJECT",
  note: string,
): Promise<ActionResult<{ outcome: CancellationOutcome; refundStatus: string | null }>> {
  const admin = await requireAdmin();
  const result = await toActionResult(async () => {
    if (decision !== "APPROVE" && decision !== "REJECT") throw new AppError("VALIDATION", "Decisão inválida.");
    const input = { decision, note: String(note ?? "") };
    const { outcome, refundId } = await decideCancellationRequest(db, getPaymentAdapter(), admin, requestId, input);
    const refund = refundId ? await db.refund.findUnique({ where: { id: refundId }, select: { status: true } }) : null;
    return { outcome, refundStatus: refund?.status ?? null };
  });
  if (result.ok) {
    sendQueuedEmails();
    refresh();
  }
  return result;
}
