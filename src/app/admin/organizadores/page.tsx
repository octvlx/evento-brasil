import { ORGANIZER_REVIEW_AREA } from "@/lib/labels";
import type { Metadata } from "next";
import { Suspense } from "react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import Link from "next/link";
import { OrganizationAdminActions, OrganizationDeleteAction, RejectOrganizationDeletionAction } from "@/features/admin/entity-actions";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { adminHas } from "@/server/auth/admin-roles";
import { listPendingOrganizationDeletionRequests } from "@/server/services/organization-deletion";
import { ORG_DELETION_BLOCKER_TEXT } from "@/lib/organization-deletion";
import { formatDateShort, formatDateTimeShort } from "@/lib/datetime";
import { ORG_STATUS, PAYMENT_ACCOUNT_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Organizadores — admin", robots: { index: false } };

export default function AdminOrganizers() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const admin = await requireAdmin("organizers:review");
  const canDelete = adminHas(admin.adminRoles, "organizers:delete");
  const deletionRequests = canDelete ? await listPendingOrganizationDeletionRequests(db, admin) : [];
  const orgs = await db.organization.findMany({
    include: {
      city: true,
      verifications: { orderBy: { createdAt: "desc" }, take: 1 },
      members: { where: { role: "OWNER" }, include: { user: { select: { email: true } } } },
      _count: { select: { events: true, members: true } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  const pending = orgs.filter((o) => o.status === "PENDING_REVIEW");
  const others = orgs.filter((o) => o.status !== "PENDING_REVIEW");

  const Row = ({ o }: { o: (typeof orgs)[number] }) => {
    const st = ORG_STATUS[o.status];
    const v = o.verifications[0];
    return (
      <li className="flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="font-semibold">
            <Link href={`/admin/organizadores/${o.id}`} className="hover:underline">
              {o.name}
            </Link>{" "}
            {o.deletedAt ? (
              <Badge variant="danger">Excluída em {formatDateShort(o.deletedAt)}</Badge>
            ) : (
              <Badge variant={st.tone === "success" ? "success" : st.tone === "warning" ? "warning" : st.tone === "danger" ? "danger" : "default"}>{st.label}</Badge>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {o.legalType === "COMPANY" ? "Empresa" : "Pessoa física"} · {v ? `${v.documentType} final ${v.documentLast4} · ${v.legalName}` : "sem verificação"} · {o.city ? `${o.city.name} – ${o.city.state}` : "cidade não informada"}
          </p>
          <p className="text-xs text-muted-foreground">
            Responsável: {o.members[0]?.user.email ?? "—"} · {o._count.events} evento(s) · recebimento: {PAYMENT_ACCOUNT_STATUS[o.paymentAccountStatus]} · desde {formatDateShort(o.createdAt)}
          </p>
          {o.statusReason && <p className="text-xs text-destructive">Motivo{o.statusReasonArea ? ` (${ORGANIZER_REVIEW_AREA[o.statusReasonArea]})` : ""}: {o.statusReason}</p>}
        </div>
        <OrganizationAdminActions o={o} />
      </li>
    );
  };

  return (
    <>
      <PageTitle title="Organizadores" subtitle={`${pending.length} aguardando análise${canDelete && deletionRequests.length ? ` · ${deletionRequests.length} pedido(s) de exclusão` : ""}`} />
      {canDelete && (
        <section aria-labelledby="deletion-queue-title" className="mb-8">
          <h2 id="deletion-queue-title" className="mb-2 text-sm font-bold">
            Pedidos de exclusão
          </h2>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card" data-testid="org-deletion-queue">
            {deletionRequests.length === 0 && <li className="p-4 text-sm text-muted-foreground">Nenhum pedido de exclusão pendente.</li>}
            {deletionRequests.map((r) => {
              const org = orgs.find((o) => o.id === r.organizationId);
              return (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-semibold">
                      <Link href={`/admin/organizadores/${r.organizationId}`} className="hover:underline">
                        {r.organization.name}
                      </Link>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Pedido por {r.requestedBy.name} ({r.requestedBy.email}) em {formatDateTimeShort(r.createdAt)}
                    </p>
                    {r.reason && <p className="text-xs">Motivo do responsável: {r.reason}</p>}
                    {r.blockers.length > 0 && <p className="text-xs text-destructive">Bloqueado hoje: {r.blockers.length} impedimento(s); os motivos aparecem ao aprovar.</p>}
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <OrganizationDeleteAction
                      o={{ id: r.organizationId, name: r.organization.name, events: org?._count.events ?? 0, members: org?._count.members ?? 0 }}
                      blockers={r.blockers.map((b) => ORG_DELETION_BLOCKER_TEXT[b])}
                      requestId={r.id}
                    />
                    <RejectOrganizationDeletionAction requestId={r.id} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <h2 className="mb-2 text-sm font-bold">Fila de aprovação</h2>
      <ul className="mb-8 divide-y divide-border rounded-2xl border border-border bg-card">
        {pending.length ? pending.map((o) => <Row key={o.id} o={o} />) : <li className="p-4 text-sm text-muted-foreground">Nenhum cadastro pendente.</li>}
      </ul>
      <h2 className="mb-2 text-sm font-bold">Todos</h2>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
        {others.map((o) => (
          <Row key={o.id} o={o} />
        ))}
      </ul>
    </>
  );
}
