import type { AdminRole } from "@/generated/prisma/client";

// Sub-papéis do admin da plataforma (T6). Cada ação administrativa exige uma
// permissão; SUPER_ADMIN tem todas. Sem papel nenhum, o admin só vê a visão geral.
// Sem "server-only": o painel usa os rótulos e o mapa para montar o menu.

export type AdminPermission =
  | "organizers:review" // aprovar/reprovar, suspender organização, auto-publicação
  | "events:moderate" // moderar, destacar, alterações de evento, regime de meia-entrada
  | "events:cancel" // cancelar evento (gera reembolsos)
  | "finance:commissions" // regras de comissão
  | "finance:refunds" // pagamentos, reembolso manual, reembolsos com falha
  | "cancellations:decide" // fila de pedidos de cancelamento
  | "transfers:read" // transferências e padrões suspeitos
  | "users:manage" // suspender cliente, redefinir 2FA
  | "audit:read" // auditoria completa
  | "admins:manage"; // papéis de outros admins

export const ADMIN_ROLES = ["SUPER_ADMIN", "FINANCE", "MODERATION", "SUPPORT"] as const satisfies readonly AdminRole[];

const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  SUPER_ADMIN: [
    "organizers:review",
    "events:moderate",
    "events:cancel",
    "finance:commissions",
    "finance:refunds",
    "cancellations:decide",
    "transfers:read",
    "users:manage",
    "audit:read",
    "admins:manage",
  ],
  FINANCE: ["finance:commissions", "finance:refunds", "cancellations:decide"],
  MODERATION: ["organizers:review", "events:moderate", "events:cancel", "transfers:read"],
  SUPPORT: ["users:manage", "transfers:read", "cancellations:decide"],
};

export const ADMIN_ROLE_LABELS: Record<AdminRole, { name: string; description: string }> = {
  SUPER_ADMIN: { name: "Super admin", description: "Tudo, inclusive os papéis de outros admins." },
  FINANCE: { name: "Financeiro", description: "Comissões, pagamentos, reembolsos e pedidos de cancelamento." },
  MODERATION: { name: "Moderação", description: "Organizadores, eventos, alterações, meia-entrada e cancelamento de evento." },
  SUPPORT: { name: "Suporte", description: "Clientes (suspensão, 2FA), transferências e pedidos de cancelamento." },
};

export function adminHas(roles: readonly AdminRole[] | null | undefined, perm: AdminPermission): boolean {
  return (roles ?? []).some((r) => ROLE_PERMISSIONS[r].includes(perm));
}

/** Menu do painel: item → permissão exigida (null = qualquer admin). */
export const ADMIN_NAV: { href: string; label: string; perm: AdminPermission | null }[] = [
  { href: "/admin", label: "Visão geral", perm: null },
  { href: "/admin/organizadores", label: "Organizadores", perm: "organizers:review" },
  { href: "/admin/eventos", label: "Eventos", perm: "events:moderate" },
  { href: "/admin/pagamentos", label: "Pedidos e pagamentos", perm: "finance:refunds" },
  { href: "/admin/cancelamentos", label: "Cancelamentos", perm: "cancellations:decide" },
  { href: "/admin/transferencias", label: "Transferências", perm: "transfers:read" },
  { href: "/admin/alteracoes", label: "Alterações de evento", perm: "events:moderate" },
  { href: "/admin/usuarios", label: "Clientes", perm: "users:manage" },
  { href: "/admin/configuracoes", label: "Comissões", perm: "finance:commissions" },
  { href: "/admin/auditoria", label: "Auditoria", perm: "audit:read" },
];
