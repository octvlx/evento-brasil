import { ORGANIZER_REVIEW_AREA } from "@/lib/labels";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { OrganizationAdminActions } from "@/features/admin/entity-actions";
import { HistoryTable, auditLinkFor } from "@/features/admin/history-table";
import { db } from "@/server/db";
import { requireAdmin } from "@/server/auth/current";
import { adminHas } from "@/server/auth/admin-roles";
import { entityHistory, parsePage } from "@/server/services/admin-oversight";
import { formatDateShort, formatDateTimeShort, formatEventDateTime } from "@/lib/datetime";
import { effectiveEventStatus } from "@/lib/event-lifecycle";
import { EVENT_STATUS, ORG_ROLE, ORG_STATUS, PAYMENT_ACCOUNT_STATUS, toneToBadge } from "@/lib/labels";

export const metadata: Metadata = { title: "Organização — admin", robots: { index: false } };

type Search = { historico?: string };

export default function AdminOrganizationDetail({ params, searchParams }: PageProps<"/admin/organizadores/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Content params={params} searchParams={searchParams as Promise<Search>} />
    </Suspense>
  );
}

async function Content({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const admin = await requireAdmin("organizers:review");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const org = await db.organization.findUnique({
    where: { id },
    include: {
      city: true,
      verifications: { orderBy: { createdAt: "desc" }, take: 5 },
      members: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } },
      events: { select: { id: true, title: true, status: true, startsAt: true, endsAt: true, timezone: true, suspendedAt: true }, orderBy: { startsAt: "desc" }, take: 50 },
      _count: { select: { events: true } },
    },
  });
  if (!org) notFound();
  const history = await entityHistory(db, admin, "Organization", org.id, parsePage(sp.historico));
  const st = ORG_STATUS[org.status];
  const canSeeUsers = adminHas(admin.adminRoles, "users:manage");
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/admin/organizadores" className="text-secondary hover:underline">
          ← Organizadores
        </Link>
      </p>
      <PageTitle title={org.name} subtitle={`${org.legalType === "COMPANY" ? "Empresa" : "Pessoa física"} · desde ${formatDateShort(org.createdAt)}`} />
      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1 text-sm">
            <p>
              <Badge variant={toneToBadge[st.tone]}>{st.label}</Badge> {org.autoPublishEvents && <Badge variant="accent">Publicação automática</Badge>}
            </p>
            {org.statusReason && <p className="text-xs text-destructive">Motivo{org.statusReasonArea ? ` (${ORGANIZER_REVIEW_AREA[org.statusReasonArea]})` : ""}: {org.statusReason}</p>}
            <p className="text-muted-foreground">
              {org.city ? `${org.city.name} – ${org.city.state}` : "Cidade não informada"} · contato {org.contactEmail}
              {org.contactPhone ? ` · ${org.contactPhone}` : ""} · recebimento: {PAYMENT_ACCOUNT_STATUS[org.paymentAccountStatus]}
            </p>
            {org.status === "APPROVED" && (
              <p>
                <Link href={`/organizadores/${org.slug}`} target="_blank" className="text-secondary hover:underline">
                  Ver perfil público
                </Link>
              </p>
            )}
          </div>
          <OrganizationAdminActions o={org} />
        </div>
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="members-title">
          <h2 id="members-title" className="mb-2 text-sm font-bold">
            Equipe
          </h2>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-sm">
            {org.members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  {canSeeUsers ? (
                    <Link href={`/admin/usuarios/${m.user.id}`} className="font-semibold hover:underline">
                      {m.user.name}
                    </Link>
                  ) : (
                    <span className="font-semibold">{m.user.name}</span>
                  )}{" "}
                  <span className="text-xs text-muted-foreground">{m.user.email}</span>
                </span>
                <Badge>{ORG_ROLE[m.role] ?? m.role}</Badge>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="verifications-title">
          <h2 id="verifications-title" className="mb-2 text-sm font-bold">
            Verificações de cadastro
          </h2>
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-sm">
            {org.verifications.length === 0 && <li className="p-3 text-muted-foreground">Nenhuma verificação.</li>}
            {org.verifications.map((v) => (
              <li key={v.id} className="space-y-0.5 p-3">
                <p>
                  {v.legalName} · {v.documentType} final {v.documentLast4} <Badge>{v.status}</Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  Enviada em {formatDateTimeShort(v.createdAt)}
                  {v.reviewedAt ? ` · analisada em ${formatDateTimeShort(v.reviewedAt)}` : ""}
                  {v.decisionNote ? ` · ${v.decisionNote}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section aria-labelledby="events-title" className="mb-6">
        <h2 id="events-title" className="mb-2 text-sm font-bold">
          Eventos ({org._count.events}
          {org._count.events > org.events.length ? `, mostrando os ${org.events.length} mais recentes` : ""})
        </h2>
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card text-sm">
          {org.events.length === 0 && <li className="p-3 text-muted-foreground">Nenhum evento.</li>}
          {org.events.map((e) => {
            const es = EVENT_STATUS[effectiveEventStatus(e)];
            return (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <Link href={`/admin/eventos/${e.id}`} className="font-semibold hover:underline">
                  {e.title}
                </Link>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {formatEventDateTime(e.startsAt, e.timezone)} <Badge variant={toneToBadge[es.tone]}>{es.label}</Badge>
                  {e.suspendedAt && <Badge variant="danger">Suspenso</Badge>}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <HistoryTable history={history} path={`/admin/organizadores/${org.id}`} auditHref={adminHas(admin.adminRoles, "audit:read") ? auditLinkFor("Organization", org.id) : undefined} />
    </>
  );
}
