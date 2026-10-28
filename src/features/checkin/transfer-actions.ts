"use server";

import { headers } from "next/headers";
import { refresh } from "next/cache";
import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { toActionResult, type ActionResult } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import {
  acceptTransfer,
  cancelTransfer,
  declineTransfer,
  requestTransfer,
  type RequestMeta,
  type RequestTransferInput,
  type TransferAccepted,
  type TransferRequested,
} from "@/server/services/transfers";

// Mesmo critério de IP das ações de autenticação e pedidos; guardado no histórico.
async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null, userAgent: h.get("user-agent") };
}

const UNAUTHENTICATED = { ok: false as const, error: "Entre na sua conta para continuar.", code: "UNAUTHENTICATED" as const };

export async function requestTransferAction(ticketId: string, input: RequestTransferInput): Promise<ActionResult<TransferRequested>> {
  const user = await getCurrentUser();
  if (!user) return UNAUTHENTICATED;
  const m = await requestMeta();
  const result = await toActionResult(async () => {
    // Cada pedido envia um e-mail: limite contra uso da plataforma para spam.
    rateLimit(`transfer:request:${user.id}`, 10, 60 * 60_000);
    const { transferId, expiresAt } = await requestTransfer(db, user, ticketId, input, m);
    return { transferId, expiresAt };
  });
  if (result.ok) refresh();
  return result;
}

export async function acceptTransferAction(token: string): Promise<ActionResult<TransferAccepted>> {
  const user = await getCurrentUser();
  if (!user) return UNAUTHENTICATED;
  const m = await requestMeta();
  const result = await toActionResult(async () => {
    rateLimit(`transfer:respond:${user.id}`, 30, 60 * 60_000);
    return acceptTransfer(db, user, token, m);
  });
  if (result.ok) refresh();
  return result;
}

export async function declineTransferAction(token: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return UNAUTHENTICATED;
  const m = await requestMeta();
  const result = await toActionResult(async () => {
    rateLimit(`transfer:respond:${user.id}`, 30, 60 * 60_000);
    await declineTransfer(db, user, token, m);
    return undefined;
  });
  if (result.ok) refresh();
  return result;
}

export async function cancelTransferAction(transferId: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return UNAUTHENTICATED;
  const m = await requestMeta();
  const result = await toActionResult(async () => {
    await cancelTransfer(db, user, transferId, m);
    return undefined;
  });
  if (result.ok) refresh();
  return result;
}
