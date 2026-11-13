"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import type { OrgRole } from "@/generated/prisma/client";
import type { CouponInput, EventInput, OrganizerApplicationInput, TicketTypeInput, TrackingLinkInput } from "@/features/schemas";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { ACTIVE_ORG_COOKIE, getActiveMembership, requireUser } from "@/server/auth/current";
import { assertOrgPermission } from "@/server/auth/permissions";
import { rateLimit } from "@/server/rate-limit";
import { getPaymentAdapter } from "@/server/payments";
import { getEmailAdapter, escapeHtml } from "@/server/email";
import { storeEventImage } from "@/server/storage";
import { cancelEvent } from "@/server/services/cancellation";
import { createCoupon, deleteCoupon, setCouponDisabled, updateCoupon } from "@/server/services/coupons";
import { createTrackingLink, setTrackingLinkArchived } from "@/server/services/tracking-links";
import { recordAcceptance } from "@/server/services/terms";
import { createEvent, deleteTicketType, duplicateEvent, submitEventForPublication, unpublishEvent, updateEvent, upsertTicketType } from "@/server/services/events";
import { extendEventChangeWindow } from "@/server/services/event-changes";
import { zonedLocalToUtc } from "@/lib/datetime";
import { recordWizardVisit, saveEventWizardStep, startEventDraft } from "@/server/services/event-wizard";
import { lookupPostalAddress } from "@/server/services/postal-address";
import { isDataStep, type DataStep, type WizardStep } from "./wizard-steps";
import {
  acceptInvitation,
  assignStaffToEvent,
  changeMemberRole,
  connectPaymentAccount,
  declineInvitation,
  inviteMember,
  removeMember,
  resendInvitation,
  resubmitOrganizerApplication,
  setOrganizationImage,
  revokeInvitation,
  submitOrganizerApplication,
  updateOrganizationProfile,
} from "@/server/services/organizers";

async function activeOrgId(userId: string) {
  const { active } = await getActiveMembership(userId);
  if (!active) redirect("/organizador/cadastro");
  return active.organizationId;
}

async function setActiveOrg(organizationId: string) {
  (await cookies()).set(ACTIVE_ORG_COOKIE, organizationId, { path: "/", httpOnly: true, sameSite: "lax", secure: env().NODE_ENV === "production" });
}

/** Aceite dos termos do organizador pela organização (R10; agente paginas-publicas). */
async function recordOrganizerTerms(userId: string, organizationId: string) {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  await recordAcceptance(db, userId, ["ORGANIZER"], { context: "ORGANIZER_SIGNUP", organizationId, ip, userAgent: h.get("user-agent") });
}

/** Cria uma NOVA organização (primeira ou adicional) e a torna ativa. */
export async function createOrganizationAction(input: OrganizerApplicationInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("/organizador/organizacoes/nova");
  return toActionResult(async () => {
    await rateLimit(`org-create:${user.id}`, 5, 60 * 60_000);
    const org = await submitOrganizerApplication(db, user, input);
    await recordOrganizerTerms(user.id, org.id);
    await setActiveOrg(org.id);
    return { id: org.id };
  });
}

/** Reenvia o cadastro de uma organização recusada. O serviço exige `org:manage` nela. */
export async function resubmitApplicationAction(organizationId: string, input: OrganizerApplicationInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("/organizador/cadastro");
  return toActionResult(async () => {
    const org = await resubmitOrganizerApplication(db, user, organizationId, input);
    await recordOrganizerTerms(user.id, org.id);
    await setActiveOrg(org.id);
    return { id: org.id };
  });
}

export async function switchOrganizationAction(formData: FormData) {
  const user = await requireUser("/organizador");
  const id = String(formData.get("organizationId") ?? "");
  const { memberships } = await getActiveMembership(user.id);
  // Só troca para uma organização da qual o usuário é membro (validação no servidor).
  if (memberships.some((m) => m.organizationId === id)) await setActiveOrg(id);
  redirect("/organizador");
}

export async function saveEventAction(eventId: string | null, input: EventInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("/organizador/eventos");
  return toActionResult(async () => {
    const event = eventId ? await updateEvent(db, user, eventId, input) : await createEvent(db, user, await activeOrgId(user.id), input);
    return { id: event.id };
  });
}

/** Prorroga a janela de reembolso de uma alteração relevante (prazo no horário local do evento). */
export async function extendEventChangeAction(changeId: string, refundUntilLocal: string, reason: string): Promise<ActionResult> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(refundUntilLocal)) throw new AppError("VALIDATION", "Informe a data e o horário do novo prazo.");
    const change = await db.eventChange.findUnique({ where: { id: changeId }, select: { event: { select: { timezone: true } } } });
    if (!change) throw new AppError("NOT_FOUND", "Alteração não encontrada.");
    await extendEventChangeWindow(db, user, changeId, { refundUntil: zonedLocalToUtc(refundUntilLocal, change.event.timezone), reason });
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

// ── Assistente de criação de evento ──

/** Etapa 1: cria (ou recupera, pela mesma `draftKey`) o rascunho na organização ativa. */
export async function startEventDraftAction(input: { draftKey: string } & Record<string, unknown>): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("/organizador/eventos/novo");
  return toActionResult(async () => {
    await rateLimit(`event-draft:${user.id}`, 30, 60 * 60_000);
    const { event } = await startEventDraft(db, user, await activeOrgId(user.id), input);
    return { id: event.id };
  });
}

/** Endereço do novo local pelo CEP (ViaCEP no servidor; o navegador só fala com o próprio site). */
export async function lookupVenuePostalCodeAction(postalCode: string) {
  const user = await requireUser("/organizador/eventos/novo");
  return toActionResult(async () => {
    await assertOrgPermission(db, user, await activeOrgId(user.id), "event:write");
    const client = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    await rateLimit(`organizer-cep:${user.id}:${client}`, 30, 60_000);
    return lookupPostalAddress(postalCode);
  });
}

export async function saveEventWizardStepAction(
  eventId: string,
  step: DataStep,
  input: Record<string, unknown>,
  complete: boolean,
): Promise<ActionResult<{ completed: DataStep[]; savedAt: string }>> {
  const user = await requireUser("/organizador/eventos/novo");
  return toActionResult(async () => {
    if (!isDataStep(step)) throw new AppError("VALIDATION", "Etapa inválida.");
    const { progress } = await saveEventWizardStep(db, user, eventId, step, input, { complete });
    return { completed: progress.completed, savedAt: new Date().toISOString() };
  });
}

export async function recordWizardVisitAction(eventId: string, step: WizardStep): Promise<ActionResult> {
  const user = await requireUser("/organizador/eventos/novo");
  return toActionResult(async () => {
    if (!Number.isInteger(step) || step < 1 || step > 6) throw new AppError("VALIDATION", "Etapa inválida.");
    await recordWizardVisit(db, user, eventId, step);
    return undefined;
  });
}

export async function uploadCoverAction(formData: FormData): Promise<ActionResult<{ url: string }>> {
  const user = await requireUser("/organizador/eventos");
  return toActionResult(async () => {
    const orgId = await activeOrgId(user.id);
    await assertOrgPermission(db, user, orgId, "event:write");
    const file = formData.get("file");
    if (!(file instanceof File)) throw new AppError("VALIDATION", "Selecione uma imagem.");
    const { url } = await storeEventImage(orgId, file);
    return { url };
  });
}

export async function saveTicketTypeAction(eventId: string, input: TicketTypeInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => ({ id: (await upsertTicketType(db, user, eventId, input)).id }));
  if (res.ok) refresh();
  return res;
}

export async function deleteTicketTypeAction(ticketTypeId: string): Promise<ActionResult> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => {
    await deleteTicketType(db, user, ticketTypeId);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export async function submitEventAction(eventId: string): Promise<ActionResult<{ status: string }>> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => ({ status: (await submitEventForPublication(db, user, eventId)).status }));
  if (res.ok) refresh();
  return res;
}

export async function unpublishEventAction(eventId: string): Promise<ActionResult<{ status: string }>> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => ({ status: (await unpublishEvent(db, user, eventId)).status }));
  if (res.ok) refresh();
  return res;
}

export async function duplicateEventAction(eventId: string, startsAtLocal: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("/organizador/eventos");
  return toActionResult(async () => ({ id: (await duplicateEvent(db, user, eventId, String(startsAtLocal ?? ""))).id }));
}

export async function cancelEventAction(eventId: string, reason: string): Promise<ActionResult<{ refunds: number }>> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => ({ refunds: (await cancelEvent(db, getPaymentAdapter(), user, eventId, reason)).refundIds.length }));
  if (res.ok) refresh();
  return res;
}

export async function connectPaymentAction(): Promise<ActionResult> {
  const user = await requireUser("/organizador/configuracoes");
  const res = await toActionResult(async () => {
    await connectPaymentAccount(db, user, await activeOrgId(user.id), getPaymentAdapter());
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export async function uploadOrgImageAction(formData: FormData): Promise<ActionResult<{ url: string | null }>> {
  const user = await requireUser("/organizador/configuracoes");
  const res = await toActionResult(async () => {
    const kind = formData.get("kind");
    if (kind !== "logo" && kind !== "cover") throw new AppError("VALIDATION", "Imagem inválida.");
    const file = formData.get("file");
    if (file !== null && !(file instanceof File)) throw new AppError("VALIDATION", "Selecione uma imagem.");
    const org = await setOrganizationImage(db, user, await activeOrgId(user.id), kind, file && file.size > 0 ? file : null);
    return { url: kind === "logo" ? org.logoUrl : org.coverUrl };
  });
  if (res.ok) refresh();
  return res;
}

export async function updateOrgProfileAction(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser("/organizador/configuracoes");
  return toActionResult(async () => {
    const site = String(formData.get("websiteUrl") ?? "").trim();
    if (site && !/^https:\/\/\S+$/.test(site)) throw new AppError("VALIDATION", "Use um endereço https://");
    await updateOrganizationProfile(db, user, await activeOrgId(user.id), {
      description: String(formData.get("description") ?? "").slice(0, 2000),
      websiteUrl: site || null,
      instagramHandle: String(formData.get("instagramHandle") ?? "").replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "").slice(0, 30) || null,
    });
    return undefined;
  });
}

async function sendInvitationEmail(orgId: string, email: string, token: string) {
  const link = `${env().APP_URL}/convite/${token}`;
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } });
  await getEmailAdapter().send({
    to: email,
    subject: `Convite para a equipe de ${org.name}`,
    html: `<p>Você foi convidado(a) para a equipe de <strong>${escapeHtml(org.name)}</strong> na QQPega.</p><p><a href="${link}">Aceitar convite</a> (válido por 7 dias)</p>`,
    text: `Aceite o convite: ${link}`,
  });
  return link;
}

export async function inviteMemberAction(_prev: ActionResult<{ link: string }> | undefined, formData: FormData): Promise<ActionResult<{ link: string }>> {
  const user = await requireUser("/organizador/equipe");
  const res = await toActionResult(async () => {
    const orgId = await activeOrgId(user.id);
    const { invitation, token } = await inviteMember(db, user, orgId, {
      email: formData.get("email"),
      role: formData.get("role"),
      eventId: formData.get("eventId") || undefined,
    });
    return { link: await sendInvitationEmail(orgId, invitation.email, token) };
  });
  if (res.ok) refresh();
  return res;
}

/** Gera um novo link (o anterior para de funcionar) e reenvia o e-mail. */
export async function resendInvitationAction(invitationId: string): Promise<ActionResult<{ link: string }>> {
  const user = await requireUser("/organizador/equipe");
  const res = await toActionResult(async () => {
    await rateLimit(`invite-resend:${user.id}`, 20, 60 * 60_000);
    const orgId = await activeOrgId(user.id);
    const { invitation, token } = await resendInvitation(db, user, orgId, invitationId);
    return { link: await sendInvitationEmail(orgId, invitation.email, token) };
  });
  if (res.ok) refresh();
  return res;
}

export async function revokeInvitationAction(invitationId: string): Promise<ActionResult> {
  const user = await requireUser("/organizador/equipe");
  const res = await toActionResult(async () => {
    await revokeInvitation(db, user, await activeOrgId(user.id), invitationId);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export async function acceptInvitationAction(token: string): Promise<ActionResult> {
  const user = await requireUser(`/convite/${token}`);
  return toActionResult(async () => {
    const inv = await acceptInvitation(db, user, token);
    (await cookies()).set(ACTIVE_ORG_COOKIE, inv.organizationId, { path: "/", httpOnly: true, sameSite: "lax", secure: env().NODE_ENV === "production" });
    return undefined;
  });
}

export async function declineInvitationAction(token: string): Promise<ActionResult> {
  const user = await requireUser(`/convite/${token}`);
  return toActionResult(async () => {
    await declineInvitation(db, user, token);
    return undefined;
  });
}

export async function changeMemberRoleAction(userId: string, role: string): Promise<ActionResult> {
  const user = await requireUser("/organizador/equipe");
  const res = await toActionResult(async () => {
    // O serviço valida o papel recebido do cliente.
    await changeMemberRole(db, user, await activeOrgId(user.id), userId, role as OrgRole);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export async function assignStaffAction(eventId: string, userId: string, assign: boolean): Promise<ActionResult> {
  const user = await requireUser("/organizador/equipe");
  const res = await toActionResult(async () => {
    await assignStaffToEvent(db, user, eventId, userId, assign);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export async function removeMemberAction(userId: string): Promise<ActionResult> {
  const user = await requireUser("/organizador/equipe");
  const res = await toActionResult(async () => {
    await removeMember(db, user, await activeOrgId(user.id), userId);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

// ── Cupons e links de divulgação ──

/** Cria (couponId nulo) ou edita um cupom; devolve avisos que não impedem salvar. */
export async function saveCouponAction(eventId: string, couponId: string | null, input: CouponInput): Promise<ActionResult<{ warnings: string[] }>> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => {
    const { warnings } = couponId ? await updateCoupon(db, user, couponId, input) : await createCoupon(db, user, eventId, input);
    return { warnings };
  });
  if (res.ok) refresh();
  return res;
}

export async function setCouponDisabledAction(couponId: string, disabled: boolean): Promise<ActionResult> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => {
    await setCouponDisabled(db, user, couponId, disabled);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export async function deleteCouponAction(couponId: string): Promise<ActionResult> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => {
    await deleteCoupon(db, user, couponId);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export async function createTrackingLinkAction(eventId: string, input: TrackingLinkInput): Promise<ActionResult<{ url: string }>> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => {
    const link = await createTrackingLink(db, user, eventId, input);
    return { url: `${env().APP_URL}/r/${link.code}` };
  });
  if (res.ok) refresh();
  return res;
}

export async function setTrackingLinkArchivedAction(linkId: string, archived: boolean): Promise<ActionResult> {
  const user = await requireUser("/organizador/eventos");
  const res = await toActionResult(async () => {
    await setTrackingLinkArchived(db, user, linkId, archived);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}
