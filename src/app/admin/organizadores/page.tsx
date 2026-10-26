import type { Metadata } from "next";
import { Suspense } from "react";
import { Badge, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { AdminActionButton } from "@/features/admin/controls";
import { autoPublishAction, reviewOrganizationAction, suspendOrganizationAction } from "@/features/admin/actions";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { formatDateShort } from "@/lib/datetime";
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
  await requireAdmin();
  const orgs = await db.organization.findMany({
    include: {
      city: true,
      verifications: { orderBy: { createdAt: "desc" }, take: 1 },
      members: { where: { role: "OWNER" }, include: { user: { select: { email: true } } } },
      _count: { select: { events: true } },
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
            {o.name} <Badge variant={st.tone === "success" ? "success" : st.tone === "warning" ? "warning" : st.tone === "danger" ? "danger" : "default"}>{st.label}</Badge>
          </p>
          <p className="text-xs text-muted-foreground">
            {o.legalType === "COMPANY" ? "Empresa" : "Pessoa física"} · {v ? `${v.documentType} final ${v.documentLast4} · ${v.legalName}` : "sem verificação"} · {o.city ? `${o.city.name} – ${o.city.state}` : "cidade não informada"}
          </p>
          <p className="text-xs text-muted-foreground">
            Responsável: {o.members[0]?.user.email ?? "—"} · {o._count.events} evento(s) · recebimento: {PAYMENT_ACCOUNT_STATUS[o.paymentAccountStatus]} · desde {formatDateShort(o.createdAt)}
          </p>
          {o.statusReason && <p className="text-xs text-destructive">Motivo: {o.statusReason}</p>}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {o.status === "PENDING_REVIEW" && (
            <>
              <AdminActionButton label="Aprovar" variant="secondary" action={reviewOrganizationAction.bind(null, o.id, "APPROVE")} />
              <AdminActionButton label="Rejeitar" variant="outline" askReason="Motivo (enviado ao organizador)" reasonRequired action={reviewOrganizationAction.bind(null, o.id, "REJECT")} />
            </>
          )}
          {o.status === "APPROVED" && (
            <>
              <AdminActionButton label={o.autoPublishEvents ? "Exigir moderação" : "Publicação automática"} action={autoPublishAction.bind(null, o.id, !o.autoPublishEvents)} />
              <AdminActionButton label="Suspender" variant="destructive" askReason="Motivo da suspensão" reasonRequired action={suspendOrganizationAction.bind(null, o.id, true)} />
            </>
          )}
          {o.status === "SUSPENDED" && <AdminActionButton label="Reativar" action={suspendOrganizationAction.bind(null, o.id, false)} confirm="Reativar a organização?" />}
        </div>
      </li>
    );
  };

  return (
    <>
      <PageTitle title="Organizadores" subtitle={`${pending.length} aguardando análise`} />
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
