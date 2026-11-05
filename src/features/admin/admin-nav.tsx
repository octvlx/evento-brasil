import { PanelNavLinks } from "@/components/site/panel-nav";
import { ADMIN_NAV, adminHas } from "@/server/auth/admin-roles";
import { getCurrentUser } from "@/server/auth/current";

/** Menu do painel só com o que o papel do admin permite (T6). A página revalida. */
export async function AdminNav() {
  const user = await getCurrentUser();
  const items = ADMIN_NAV.filter((i) => i.perm === null || adminHas(user?.adminRoles, i.perm));
  return <PanelNavLinks items={items.map((i) => [i.href, i.label])} root="/admin" />;
}
