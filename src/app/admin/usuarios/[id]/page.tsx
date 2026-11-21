import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { UserAdminActions } from "@/features/admin/entity-actions";
import { HistoryTable, auditLinkFor } from "@/features/admin/history-table";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { ADMIN_ROLE_LABELS, adminHas } from "@/server/auth/admin-roles";
import { entityHistory, parsePage } from "@/server/services/admin-oversight";
import { formatDateShort, formatDateTimeShort } from "@/lib/datetime";
import { ORDER_STATUS, ORG_ROLE, toneToBadge } from "@/lib/labels";

export const metadata: Metadata = { title: "Usuário — admin", robots: { index: false } };

type Search = { historico?: string };

export default function AdminUserDetail({ params, searchParams }: PageProps<"/admin/usuarios/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content params={params} searchParams={searchParams as Promise<Search>} />
    </Suspense>
  );
}

async function Content({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const admin = await requireAdmin("users:manage");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  // Sem CPF, endereço nem dados de pagamento: o suporte vê só o necessário para atender.
  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      platformRole: true,
      adminRoles: true,
      status: true,
      suspendedReason: true,
      isDemoAccount: true,
      anonymizedAt: true,
      totpEnabledAt: true,
      emailVerifiedAt: true,
      googleSubject: true,
      createdAt: true,
      memberships: { select: { role: true, organization: { select: { id: true, name: true } } } },
      _count: { select: { orders: true, heldTickets: true } },
    },
  });
  if (!user) notFound();
  const [history, orders] = await Promise.all([
    entityHistory(db, admin, "User", user.id, parsePage(sp.historico)),
    db.order.findMany({
      where: { userId: user.id },
      select: { id: true, publicCode: true, status: true, createdAt: true, event: { select: { id: true, title: true } } },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);
  const canSeeOrgs = adminHas(admin.adminRoles, "organizers:review");
  const canSeeEvents = adminHas(admin.adminRoles, "events:moderate");
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/admin/usuarios" className="text-secondary hover:underline">
          ← Clientes
        </Link>
      </p>
      <PageTitle title={user.name} subtitle={`${user.email} · desde ${formatDateShort(user.createdAt)}`} />
      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 text-sm">
            <p className="flex flex-wrap gap-1">
              {user.anonymizedAt ? <Badge>Conta excluída</Badge> : user.status === "SUSPENDED" ? <Badge variant="danger">Suspenso</Badge> : <Badge variant="success">Ativo</Badge>}
              {user.platformRole === "ADMIN" && (
                <Badge variant="primary">Admin{user.adminRoles.length ? `: ${user.adminRoles.map((r) => ADMIN_ROLE_LABELS[r].name).join(", ")}` : " (sem papel)"}</Badge>
              )}
              {user.totpEnabledAt && <Badge variant="success">2FA</Badge>}
              {user.isDemoAccount && <Badge variant="warning">demo</Badge>}
            </p>
            {user.status === "SUSPENDED" && user.suspendedReason && <p className="text-xs text-destructive">Motivo: {user.suspendedReason}</p>}
            <p className="text-muted-foreground">
              E-mail {user.emailVerifiedAt ? `confirmado em ${formatDateShort(user.emailVerifiedAt)}` : "não confirmado"} · {user.googleSubject ? "login com Google vinculado" : "sem login com Google"}
            </p>
            <p className="text-muted-foreground">
              {user._count.orders} pedidos · {user._count.heldTickets} ingressos em nome dele
            </p>
          </div>
          <UserAdminActions
            admin={admin}
            u={{ ...user, ordersCount: user._count.orders, organizations: user.memberships.map((m) => m.organization.name) }}
          />
        </div>
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="orgs-title">
          <h2 id="orgs-title" className="mb-2 text-sm font-bold">
            Organizações
          </h2>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-sm">
            {user.memberships.length === 0 && <li className="p-3 text-muted-foreground">Nenhuma.</li>}
            {user.memberships.map((m) => (
              <li key={m.organization.id} className="flex items-center justify-between gap-2 p-3">
                {canSeeOrgs ? (
                  <Link href={`/admin/organizadores/${m.organization.id}`} className="font-semibold hover:underline">
                    {m.organization.name}
                  </Link>
                ) : (
                  <span className="font-semibold">{m.organization.name}</span>
                )}
                <Badge>{ORG_ROLE[m.role] ?? m.role}</Badge>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="orders-title">
          <h2 id="orders-title" className="mb-2 text-sm font-bold">
            Pedidos recentes
          </h2>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-sm">
            {orders.length === 0 && <li className="p-3 text-muted-foreground">Nenhum pedido.</li>}
            {orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  <span className="font-mono text-xs">{o.publicCode}</span> ·{" "}
                  {canSeeEvents ? (
                    <Link href={`/admin/eventos/${o.event.id}`} className="hover:underline">
                      {o.event.title}
                    </Link>
                  ) : (
                    o.event.title
                  )}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {formatDateTimeShort(o.createdAt)} <Badge variant={toneToBadge[ORDER_STATUS[o.status].tone]}>{ORDER_STATUS[o.status].label}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <HistoryTable history={history} path={`/admin/usuarios/${user.id}`} auditHref={adminHas(admin.adminRoles, "audit:read") ? auditLinkFor("User", user.id) : undefined} />
    </>
  );
}
