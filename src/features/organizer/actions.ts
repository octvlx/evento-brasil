"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import type { EventInput, OrganizerApplicationInput, TicketTypeInput } from "@/features/schemas";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError, toActionResult, type ActionResult } from "@/server/errors";
import { ACTIVE_ORG_COOKIE, getActiveMembership, requireUser } from "@/server/auth/current";
import { assertOrgPermission } from "@/server/auth/permissions";
import { getPaymentAdapter } from "@/server/payments";
import { getEmailAdapter, escapeHtml } from "@/server/email";
import { storeEventImage } from "@/server/storage";
import { cancelEvent } from "@/server/services/cancellation";
import { createEvent, deleteTicketType, submitEventForPublication, updateEvent, upsertTicketType } from "@/server/services/events";
import {
  acceptInvitation,
  assignStaffToEvent,
  connectPaymentAccount,
  inviteMember,
  removeMember,
  resubmitOrganizerApplication,
  submitOrganizerApplication,
  updateOrganizationProfile,
} from "@/server/services/organizers";

async function activeOrgId(userId: string) {
  const { active } = await getActiveMembership(userId);
  if (!active) redirect("/organizador/cadastro");
  return active.organizationId;
}

export async function submitApplicationAction(input: OrganizerApplicationInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser("/organizador/cadastro");
  return toActionResult(async () => {
    const { active } = await getActiveMembership(user.id);
    const org =
      active && (active.organization.status === "REJECTED" || active.organization.status === "DRAFT")
        ? await resubmitOrganizerApplication(db, user, active.organizationId, input)
        : await submitOrganizerApplication(db, user, input);
    (await cookies()).set(ACTIVE_ORG_COOKIE, org.id, { path: "/", httpOnly: true, sameSite: "lax", secure: env().NODE_ENV === "production" });
    return { id: org.id };
  });
}

export async function switchOrganizationAction(formData: FormData) {
  const user = await requireUser("/organizador");
  const id = String(formData.get("organizationId") ?? "");
  const { memberships } = await getActiveMembership(user.id);
  if (memberships.some((m) => m.organizationId === id)) {
    (await cookies()).set(ACTIVE_ORG_COOKIE, id, { path: "/", httpOnly: true, sameSite: "lax", secure: env().NODE_ENV === "production" });
  }
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

export async function inviteMemberAction(_prev: ActionResult<{ link: string }> | undefined, formData: FormData): Promise<ActionResult<{ link: string }>> {
  const user = await requireUser("/organizador/configuracoes");
  const res = await toActionResult(async () => {
    const orgId = await activeOrgId(user.id);
    const { invitation, token } = await inviteMember(db, user, orgId, {
      email: formData.get("email"),
      role: formData.get("role"),
      eventId: formData.get("eventId") || undefined,
    });
    const link = `${env().APP_URL}/convite/${token}`;
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } });
    await getEmailAdapter().send({
      to: invitation.email,
      subject: `Convite para a equipe de ${org.name}`,
      html: `<p>Você foi convidado(a) para a equipe de <strong>${escapeHtml(org.name)}</strong> no Evento Brasil.</p><p><a href="${link}">Aceitar convite</a> (válido por 7 dias)</p>`,
      text: `Aceite o convite: ${link}`,
    });
    return { link };
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
