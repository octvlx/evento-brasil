import { Suspense } from "react";
import { PanelShell } from "@/components/site/panel-shell";
import { AdminNav } from "@/features/admin/admin-nav";

// A autorização é verificada em cada página e em cada ação (requireAdmin / assertAdminPermission);
// o menu só esconde o que o papel do admin não permite (T6).
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <PanelShell
      title="Administração"
      nav={[]}
      collapsible
      aside={
        <Suspense fallback={null}>
          <AdminNav />
        </Suspense>
      }
    >
      {children}
    </PanelShell>
  );
}
