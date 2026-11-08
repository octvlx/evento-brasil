"use server";

import { refresh } from "next/cache";
import { commissionRuleInputSchema } from "@/features/schemas";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { getPaymentAdapter } from "@/server/payments";
import { cancelEvent } from "@/server/services/cancellation";
import { setCommissionRule } from "@/server/services/commission";
import { moderateEvent, setEventFeatured } from "@/server/services/events";
import { reviewOrganization, setAutoPublish, setOrganizationSuspended } from "@/server/services/organizers";
import { adminRefundOrder, processRefund } from "@/server/services/refunds";
import { setAdminRoles, setUserSuspended } from "@/server/services/users";
import { adminResetTwoFactor } from "@/server/services/two-factor";
import { adminDeleteAccount } from "@/server/services/account-deletion";
import { rateLimit } from "@/server/rate-limit";
import {
  adminAutoCoverExternalEvent,
  adminFeatureExternalEvents,
  adminPublishExternalEvents,
  adminDeleteExternalEvent,
  adminImportExternalEventByUrl,
  adminPreviewExternalCover,
  adminRemoveExternalCover,
  adminReviewExternalEvent,
  adminRunExternalImport,
  adminSetExternalCoverFromUrl,
  adminSetExternalFeatured,
  adminSetSourceStatus,
  adminUploadExternalCover,
} from "@/server/services/external-events";
import type { BulkFeatureItem, BulkPublishItem } from "@/server/services/external-events";
import type { CoverPreview } from "@/server/external/cover";

async function run(fn: (admin: Awaited<ReturnType<typeof requireAdmin>>) => Promise<unknown>): Promise<ActionResult> {
  const admin = await requireAdmin();
  const res = await toActionResult(async () => {
    await fn(admin);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export const reviewOrganizationAction = async (id: string, decision: "APPROVE" | "REJECT", note?: string) =>
  run((a) => reviewOrganization(db, a, id, decision, note));
export const suspendOrganizationAction = async (id: string, suspended: boolean, reason?: string) =>
  run((a) => setOrganizationSuspended(db, a, id, suspended, reason));
export const autoPublishAction = async (id: string, value: boolean) => run((a) => setAutoPublish(db, a, id, value));
export const moderateEventAction = async (id: string, decision: "APPROVE" | "REJECT", note?: string) => run((a) => moderateEvent(db, a, id, decision, note));
export const featureEventAction = async (id: string, featured: boolean) => run((a) => setEventFeatured(db, a, id, featured));
export const adminCancelEventAction = async (id: string, reason?: string) =>
  run((a) => cancelEvent(db, getPaymentAdapter(), a, id, reason ?? "", { asAdmin: true }));
export const suspendUserAction = async (id: string, suspended: boolean, reason?: string) => run((a) => setUserSuspended(db, a, id, suspended, reason));
export const setAdminRolesAction = async (id: string, roles: string[]) => run((a) => setAdminRoles(db, a, id, Array.isArray(roles) ? roles.map(String) : []));
export const resetUserTwoFactorAction = async (id: string, adminCode: string, reason: string) =>
  run(async (a) => {
    await rateLimit(`mfa-admin-reset:${a.id}`, 10, 15 * 60_000);
    await adminResetTwoFactor(db, a, id, { adminCode, reason });
  });
export const deleteUserAccountAction = async (id: string, confirmEmail: string, reason: string, adminCode: string) =>
  run(async (a) => {
    await rateLimit(`account-admin-delete:${a.id}`, 10, 15 * 60_000);
    await adminDeleteAccount(db, a, id, { confirmEmail: String(confirmEmail), reason: String(reason), adminCode: String(adminCode) });
  });
export const adminRefundAction =async (orderId: string, note?: string) => run((a) => adminRefundOrder(db, getPaymentAdapter(), a, orderId, note ?? ""));
export const retryRefundAction = async (refundId: string) => run(() => processRefund(db, getPaymentAdapter(), refundId));

export async function saveCommissionRuleAction(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const parsed = commissionRuleInputSchema.safeParse({
    scope: formData.get("scope"),
    organizationId: formData.get("organizationId") || undefined,
    eventId: formData.get("eventId") || undefined,
    percent: formData.get("percent"),
    fixedCentsPerTicket: formData.get("fixedCentsPerTicket") || 0,
    bearer: formData.get("bearer"),
    processingFeeBearer: formData.get("processingFeeBearer"),
    refundCommissionOnRefund: formData.get("refundCommissionOnRefund") === "on",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const v = parsed.data;
  return run((a) =>
    setCommissionRule(db, a, {
      scope: v.scope,
      organizationId: v.organizationId,
      eventId: v.eventId,
      percentBps: Math.round(v.percent * 100),
      fixedCentsPerTicket: v.fixedCentsPerTicket,
      bearer: v.bearer,
      processingFeeBearer: v.processingFeeBearer,
      refundCommissionOnRefund: v.refundCommissionOnRefund,
    }),
  );
}

// Eventos externos (descoberta): permissão de moderação conferida nos serviços.
// Cada busca de capa faz o servidor baixar a página e até 5 imagens de um site público
// qualquer: o limite evita uso do servidor como "baixador" em massa e bloqueio pelos
// sites. Busca manual e capa automática ao publicar têm orçamentos separados.
const COVER_PER_HOUR = 150;
const AUTO_COVER_PER_HOUR = 500;
async function coverLimit(adminId: string) {
  try {
    await rateLimit(`external-cover:${adminId}`, COVER_PER_HOUR, 60 * 60_000);
  } catch (e) {
    if (e instanceof AppError && e.code === "RATE_LIMITED")
      throw new AppError("RATE_LIMITED", `Limite de ${COVER_PER_HOUR} buscas de capa por hora atingido. Aguarde um pouco ou envie o arquivo da imagem (o envio não tem esse limite).`);
    throw e;
  }
}
export const setExternalSourceStatusAction = async (sourceId: string, status: "ACTIVE" | "PAUSED") => run((a) => adminSetSourceStatus(db, a, sourceId, status));
export const runExternalImportAction = async (sourceId: string, maxEvents: number) =>
  run(async (a) => {
    await rateLimit(`external-import:${a.id}`, 6, 60 * 60_000);
    await adminRunExternalImport(db, a, sourceId, Number(maxEvents));
  });
/**
 * Publicar já busca a capa na página original (sem capa ainda). Falha aqui não desfaz
 * a publicação: o admin pode definir a capa depois, na edição.
 */
async function autoCoverAfterPublish(admin: Awaited<ReturnType<typeof requireAdmin>>, eventId: string): Promise<"set" | "kept" | "none"> {
  try {
    // Orçamento próprio: publicar em lote não pode esgotar o "Buscar capa" manual.
    await rateLimit(`external-autocover:${admin.id}`, AUTO_COVER_PER_HOUR, 60 * 60_000);
    return await adminAutoCoverExternalEvent(db, admin, eventId);
  } catch (e) {
    console.warn("Capa automática do evento externo falhou:", e instanceof Error ? e.message : e);
    return "none";
  }
}

export const reviewExternalEventAction = async (eventId: string, review: "PUBLISHED" | "HIDDEN" | "PENDING_REVIEW") =>
  run(async (a) => {
    await adminReviewExternalEvent(db, a, eventId, review);
    if (review === "PUBLISHED") await autoCoverAfterPublish(a, eventId);
  });

export type BulkPublishResult = (BulkPublishItem & { cover?: "set" | "kept" | "none" })[];

/**
 * Publicação em lote: só os ids enviados (a seleção explícita do admin), pelo mesmo
 * serviço da publicação individual. Depois busca as capas, 4 por vez, sem bloquear
 * o resultado da publicação. Uma única Server Action: o cliente as executa em fila.
 */
export async function publishExternalEventsAction(ids: string[]): Promise<ActionResult<BulkPublishResult>> {
  const admin = await requireAdmin();
  const res = await toActionResult(async () => {
    const results: BulkPublishResult = await adminPublishExternalEvents(db, admin, ids);
    const toCover = results.filter((r) => r.status === "published");
    for (let i = 0; i < toCover.length; i += 4) {
      await Promise.all(toCover.slice(i, i + 4).map(async (r) => (r.cover = await autoCoverAfterPublish(admin, r.id))));
    }
    return results;
  });
  if (res.ok) refresh();
  return res;
}
export const featureExternalEventAction = async (eventId: string, featured: boolean) => run((a) => adminSetExternalFeatured(db, a, eventId, featured === true));

/** Destaque em lote: só os ids enviados, pelo serviço do destaque individual; atualiza a lista. */
export async function featureExternalEventsAction(ids: string[]): Promise<ActionResult<BulkFeatureItem[]>> {
  const admin = await requireAdmin();
  const res = await toActionResult(() => adminFeatureExternalEvents(db, admin, ids));
  if (res.ok) refresh();
  return res;
}
export const deleteExternalEventAction = async (eventId: string) => run((a) => adminDeleteExternalEvent(db, a, eventId));
export const removeExternalCoverAction = async (eventId: string) => run((a) => adminRemoveExternalCover(db, a, eventId));

/** Cadastro por link: devolve o id do evento para abrir a edição. */
export async function importExternalByUrlAction(url: string): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  return toActionResult(async () => {
    await rateLimit(`external-url:${admin.id}`, 30, 60 * 60_000);
    const { id } = await adminImportExternalEventByUrl(db, admin, String(url));
    return { id };
  });
}

/** Prévia da capa: só busca e mostra candidatas (nada é gravado). */
export async function previewExternalCoverAction(eventId: string, url: string): Promise<ActionResult<CoverPreview>> {
  const admin = await requireAdmin();
  return toActionResult(async () => {
    await coverLimit(admin.id);
    return adminPreviewExternalCover(db, admin, eventId, String(url));
  });
}

export const saveExternalCoverAction = async (eventId: string, imageUrl: string) =>
  run(async (a) => {
    await coverLimit(a.id);
    await adminSetExternalCoverFromUrl(db, a, eventId, String(imageUrl));
  });

export async function uploadExternalCoverAction(eventId: string, formData: FormData): Promise<ActionResult> {
  const file = formData.get("file");
  return run(async (a) => {
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Escolha um arquivo de imagem.");
    await adminUploadExternalCover(db, a, eventId, file);
  });
}
