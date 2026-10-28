import { PanelShell } from "@/components/site/panel-shell";

const NAV: [string, string][] = [
  ["/admin", "Visão geral"],
  ["/admin/organizadores", "Organizadores"],
  ["/admin/eventos", "Eventos"],
  ["/admin/pagamentos", "Pedidos e pagamentos"],
  ["/admin/cancelamentos", "Cancelamentos"],
  ["/admin/transferencias", "Transferências"],
  ["/admin/alteracoes", "Alterações de evento"],
  ["/admin/usuarios", "Clientes"],
  ["/admin/configuracoes", "Comissões"],
  ["/admin/auditoria", "Auditoria"],
];

// A autorização é verificada em cada página e em cada ação (requireAdmin).
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <PanelShell title="Administração" nav={NAV}>
      {children}
    </PanelShell>
  );
}
