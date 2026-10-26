import "server-only";
import type { OrgRole, PlatformRole, UserStatus } from "@/generated/prisma/client";
import type { Db, Tx } from "../db";
import { AppError, forbidden } from "../errors";

export interface Actor {
  id: string;
  platformRole: PlatformRole;
  status: UserStatus;
}

export type OrgPermission =
  | "org:read"
  | "org:manage"
  | "members:manage"
  | "event:write"
  | "event:publish"
  | "event:cancel"
  | "attendees:read"
  | "finance:read"
  | "checkin:scan"
  | "checkin:history";

const ROLE_PERMISSIONS: Record<OrgRole, readonly OrgPermission[]> = {
  OWNER: ["org:read", "org:manage", "members:manage", "event:write", "event:publish", "event:cancel", "attendees:read", "finance:read", "checkin:scan", "checkin:history"],
  ADMIN: ["org:read", "org:manage", "members:manage", "event:write", "event:publish", "event:cancel", "attendees:read", "finance:read", "checkin:scan", "checkin:history"],
  EVENT_MANAGER: ["org:read", "event:write", "event:publish", "attendees:read", "checkin:scan", "checkin:history"],
  FINANCE: ["org:read", "finance:read", "attendees:read"],
  // Equipe de check-in só atua em eventos atribuídos (EventStaffAssignment).
  CHECKIN_STAFF: ["checkin:scan"],
};

export function roleHas(role: OrgRole, perm: OrgPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}

export function assertActive(actor: Actor): void {
  if (actor.status !== "ACTIVE") throw new AppError("FORBIDDEN", "Sua conta está suspensa.");
}

export function assertPlatformAdmin(actor: Actor): void {
  assertActive(actor);
  if (actor.platformRole !== "ADMIN") throw forbidden();
}

/** Garante que o ator é membro da organização com a permissão exigida. */
export async function assertOrgPermission(client: Db | Tx, actor: Actor, organizationId: string, perm: OrgPermission) {
  assertActive(actor);
  const membership = await client.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: actor.id } },
    select: { role: true, organization: { select: { status: true } } },
  });
  if (!membership || !roleHas(membership.role, perm)) throw forbidden();
  if (membership.organization.status === "SUSPENDED" && perm !== "org:read" && perm !== "finance:read") {
    throw new AppError("FORBIDDEN", "Esta organização está suspensa.");
  }
  return membership;
}

/** Permissão em um evento específico (resolve a organização dona). */
export async function assertEventPermission(client: Db | Tx, actor: Actor, eventId: string, perm: OrgPermission) {
  const event = await client.event.findUnique({ where: { id: eventId }, select: { organizationId: true } });
  if (!event) throw forbidden();
  await assertOrgPermission(client, actor, event.organizationId, perm);
  return event;
}

/**
 * Acesso ao check-in: OWNER/ADMIN/EVENT_MANAGER da organização dona, ou equipe
 * CHECKIN_STAFF com atribuição explícita ao evento.
 */
export async function resolveCheckinAccess(client: Db | Tx, actor: Actor, eventId: string) {
  assertActive(actor);
  const event = await client.event.findUnique({ where: { id: eventId }, select: { id: true, organizationId: true } });
  if (!event) throw forbidden();
  const membership = await client.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId: event.organizationId, userId: actor.id } },
    select: { role: true },
  });
  if (!membership) throw forbidden();
  if (roleHas(membership.role, "checkin:history")) return { event, canSeeAllHistory: true };
  if (membership.role === "CHECKIN_STAFF") {
    const assigned = await client.eventStaffAssignment.findUnique({
      where: { eventId_userId: { eventId, userId: actor.id } },
      select: { id: true },
    });
    if (assigned) return { event, canSeeAllHistory: false };
  }
  throw forbidden();
}
