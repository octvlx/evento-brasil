import "server-only";
import { redirect } from "next/navigation";
import { getActiveMembership, requireUser } from "./current";
import { roleHas, type OrgPermission } from "./permissions";

/** Usuário + organização ativa. Sem organização → onboarding. */
export async function requireOrganizer(path = "/organizador") {
  const user = await requireUser(path);
  const { active, memberships } = await getActiveMembership(user.id);
  if (!active) redirect("/organizador/cadastro");
  if (active.role === "CHECKIN_STAFF" && !memberships.some((m) => m.role !== "CHECKIN_STAFF")) redirect("/check-in");
  const can = (perm: OrgPermission) => roleHas(active.role, perm);
  return { user, membership: active, org: active.organization, memberships, can };
}
