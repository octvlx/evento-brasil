import type { Metadata } from "next";
import { Suspense } from "react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { AdminActionButton } from "@/features/admin/controls";
import { suspendUserAction } from "@/features/admin/actions";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { formatDateShort } from "@/lib/datetime";

export const metadata: Metadata = { title: "Clientes — admin", robots: { index: false } };

export default function AdminUsers({ searchParams }: PageProps<"/admin/usuarios">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content searchParams={searchParams as Promise<{ q?: string }>} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const admin = await requireAdmin();
  const { q } = await searchParams;
  const users = await db.user.findMany({
    where: q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {},
    include: { _count: { select: { orders: true, tickets: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return (
    <>
      <PageTitle title="Clientes" />
      <form className="mb-4 max-w-sm">
        <input name="q" defaultValue={q} placeholder="Buscar por nome ou e-mail" aria-label="Buscar usuários" className="h-10 w-full rounded-xl border border-input bg-card px-3 text-sm" />
      </form>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
        {users.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <div>
              <p className="font-semibold">
                {u.name} {u.platformRole === "ADMIN" && <Badge variant="primary">Admin</Badge>} {u.status === "SUSPENDED" && <Badge variant="danger">Suspenso</Badge>}{" "}
                {u.isDemoAccount && <Badge variant="warning">demo</Badge>}
              </p>
              <p className="text-xs text-muted-foreground">
                {u.email} · {u._count.orders} pedidos · {u._count.tickets} ingressos · desde {formatDateShort(u.createdAt)}
              </p>
            </div>
            {u.id !== admin.id &&
              (u.status === "ACTIVE" ? (
                <AdminActionButton label="Suspender" variant="destructive" askReason="Motivo" reasonRequired action={suspendUserAction.bind(null, u.id, true)} />
              ) : (
                <AdminActionButton label="Reativar" action={suspendUserAction.bind(null, u.id, false)} />
              ))}
          </li>
        ))}
      </ul>
    </>
  );
}
