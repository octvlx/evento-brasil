import Link from "next/link";
import { ADMIN_NAV, adminHas } from "@/server/auth/admin-roles";
import { getCurrentUser } from "@/server/auth/current";

/** Menu do painel só com o que o papel do admin permite (T6). A página revalida. */
export async function AdminNav() {
  const user = await getCurrentUser();
  const items = ADMIN_NAV.filter((i) => i.perm === null || adminHas(user?.adminRoles, i.perm));
  return (
    <nav className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
      {items.map((i) => (
        <Link key={i.href} href={i.href} className="shrink-0 rounded-xl px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
