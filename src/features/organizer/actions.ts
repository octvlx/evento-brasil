"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import type { OrgRole } from "@/generated/prisma/client";
import type { EventInput, OrganizerApplicationInput, TicketTypeInput } from "@/features/schemas";
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
import { createEvent, deleteTicketType, submitEventForPublication, updateEvent, upsertTicketType } from "@/server/services/events";
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

/** Cria uma NOVA organização (primeira ou adicional) e a torna ativa. */
export async function createOrganizationAction(input: OrganizerApplicationInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("/organizador/organizacoes/nova");
  return toActionResult(async () => {
    rateLimit(`org-create:${user.id}`, 5, 60 * 60_000);
    const org = await submitOrganizerApplication(db, user, input);
    await setActiveOrg(org.id);
    return { id: org.id };
  });
}

/** Reenvia o cadastro de uma organização recusada. O serviço exige `org:manage` nela. */
export async function resubmitApplicationAction(organizationId: string, input: OrganizerApplicationInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("/organizador/cadastro");
  return toActionResult(async () => {
    const org = await resubmitOrganizerApplication(db, user, organizationId, input);
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
    html: `<p>Você foi convidado(a) para a equipe de <strong>${escapeHtml(org.name)}</strong> no Evento Brasil.</p><p><a href="${link}">Aceitar convite</a> (válido por 7 dias)</p>`,
    text: `Aceite o convite: ${link}`,
  });
  return link;
}

export async function inviteMemberAction(_prev: ActionResult<{ link: string }> | undefined, formData: FormData): Promise<ActionResult<{ link: string }>> {
  const user = await requireUser("/organizador/configuracoes");
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
  const user = await requireUser("/organizador/configuracoes");
  const res = await toActionResult(async () => {
    rateLimit(`invite-resend:${user.id}`, 20, 60 * 60_000);
    const orgId = await activeOrgId(user.id);
    const { invitation, token } = await resendInvitation(db, user, orgId, invitationId);
    return { link: await sendInvitationEmail(orgId, invitation.email, token) };
  });
  if (res.ok) refresh();
  return res;
}

export async function revokeInvitationAction(invitationId: string): Promise<ActionResult> {
  const user = await requireUser("/organizador/configuracoes");
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
  const user = await requireUser("/organizador/configuracoes");
  const res = await toActionResult(async () => {
    // O serviço valida o papel recebido do cliente.
    await changeMemberRole(db, user, await activeOrgId(user.id), userId, role as OrgRole);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export async function assignStaffAction(eventId: string, userId: string, assign: boolean): Promise<ActionResult> {
  const user = await requireUser("/organizador/configuracoes");
  const res = await toActionResult(async () => {
    await assignStaffToEvent(db, user, eventId, userId, assign);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}

export async function removeMemberAction(userId: string): Promise<ActionResult> {
  const user = await requireUser("/organizador/configuracoes");
  const res = await toActionResult(async () => {
    await removeMember(db, user, await activeOrgId(user.id), userId);
    return undefined;
  });
  if (res.ok) refresh();
  return res;
}
