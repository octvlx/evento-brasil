import { Suspense } from "react";
import { PanelShell } from "@/components/site/panel-shell";
import { Select } from "@/components/ui/primitives";
import { getActiveMembership, getCurrentUser } from "@/server/auth/current";
import { switchOrganizationAction } from "@/features/organizer/actions";

const NAV: [string, string][] = [
  ["/organizador", "Visão geral"],
  ["/organizador/eventos", "Eventos"],
  ["/organizador/vendas", "Vendas e repasses"],
  ["/organizador/participantes", "Participantes"],
  ["/organizador/configuracoes", "Configurações"],
  ["/check-in", "Check-in"],
];

export default function OrganizerLayout({ children }: LayoutProps<"/organizador">) {
  return (
    <PanelShell
      title="Organizador"
      nav={NAV}
      aside={
        <Suspense fallback={null}>
          <OrgSwitcher />
        </Suspense>
      }
    >
      {children}
    </PanelShell>
  );
}

async function OrgSwitcher() {
  const user = await getCurrentUser();
  if (!user) return null;
  const { active, memberships } = await getActiveMembership(user.id);
  if (memberships.length < 2) return active ? <p className="mb-3 truncate px-3 text-sm font-bold">{active.organization.name}</p> : null;
  return (
    <form action={switchOrganizationAction} className="mb-3 px-1">
      <label className="sr-only" htmlFor="org-switch">
        Organização ativa
      </label>
      <div className="flex gap-1">
        <Select id="org-switch" name="organizationId" defaultValue={active?.organizationId} className="h-9 text-xs">
          {memberships.map((m) => (
            <option key={m.organizationId} value={m.organizationId}>
              {m.organization.name}
            </option>
          ))}
        </Select>
        <button className="rounded-xl bg-muted px-2 text-xs font-semibold">Trocar</button>
      </div>
    </form>
  );
}
