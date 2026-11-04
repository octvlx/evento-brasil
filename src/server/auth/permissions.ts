import "server-only";
import type { AdminRole, OrgRole, PlatformRole, UserStatus } from "@/generated/prisma/client";
import type { Db, Tx } from "../db";
import { AppError, forbidden } from "../errors";
import { adminHas, type AdminPermission } from "./admin-roles";
import { MFA_REQUIRED_MESSAGE, needsMfaEnrollment } from "./mfa-policy";

export interface Actor {
  id: string;
  platformRole: PlatformRole;
  status: UserStatus;
  /** Verificação em duas etapas ativa (vem da sessão); exigida de admin e dono de organização. */
  totpEnabledAt?: Date | null;
  /** Sub-papéis do admin (T6); vêm da sessão. */
  adminRoles?: AdminRole[];
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

/** Admin e dono de organização sem 2FA ativo não usam a área privilegiada (quando exigido). */
function assertMfaEnrolled(actor: Actor): void {
  if (needsMfaEnrollment(actor)) throw new AppError("MFA_REQUIRED", MFA_REQUIRED_MESSAGE);
}

/** Qualquer admin da plataforma (visão geral). Ações específicas usam assertAdminPermission. */
export function assertPlatformAdmin(actor: Actor): void {
  assertActive(actor);
  if (actor.platformRole !== "ADMIN") throw forbidden();
  assertMfaEnrolled(actor);
}

/** Admin com o sub-papel que dá esta permissão (T6). */
export function assertAdminPermission(actor: Actor, perm: AdminPermission): void {
  assertPlatformAdmin(actor);
  if (!adminHas(actor.adminRoles, perm)) throw forbidden("Seu papel de administrador não permite esta ação.");
}

/** Garante que o ator é membro da organização com a permissão exigida. */
export async function assertOrgPermission(client: Db | Tx, actor: Actor, organizationId: string, perm: OrgPermission) {
  assertActive(actor);
  const membership = await client.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: actor.id } },
    select: { role: true, organization: { select: { status: true } } },
  });
  if (!membership || !roleHas(membership.role, perm)) throw forbidden();
  if (membership.role === "OWNER") assertMfaEnrolled(actor);
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
    select: { role: true, organization: { select: { status: true } } },
  });
  if (!membership) throw forbidden();
  if (membership.organization.status === "SUSPENDED") throw forbidden();
  if (membership.role === "OWNER") assertMfaEnrolled(actor);
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
