import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import { ConnectPaymentButton, InviteForm, ProfileSettingsForm, RemoveMemberButton, StaffAssignmentToggle } from "@/features/organizer/settings-forms";
import { db } from "@/server/db";
import { getPaymentAdapter } from "@/server/payments";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { ORG_ROLE, ORG_STATUS, PAYMENT_ACCOUNT_STATUS } from "@/lib/labels";

export const metadata: Metadata = { title: "Configurações", robots: { index: false } };

export default function SettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[700px]" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const { org: activeOrg, can } = await requireOrganizer("/organizador/configuracoes");
  if (!can("org:manage")) redirect("/organizador");
  const org = await db.organization.findUniqueOrThrow({
    where: { id: activeOrg.id },
    include: {
      members: { include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } },
      verifications: { orderBy: { createdAt: "desc" }, take: 1 },
      invitations: { where: { acceptedAt: null, revokedAt: null }, orderBy: { createdAt: "desc" } },
    },
  });
  const events = await db.event.findMany({
    where: { organizationId: org.id, status: { in: ["DRAFT", "PENDING_REVIEW", "PUBLISHED"] } },
    select: { id: true, title: true, staffAssignments: { select: { userId: true } } },
    orderBy: { startsAt: "asc" },
  });
  const adapter = getPaymentAdapter();
  const v = org.verifications[0];
  const staff = org.members.filter((m) => m.role === "CHECKIN_STAFF");

  return (
    <>
      <PageTitle title="Configurações" subtitle={`${org.name} · ${ORG_STATUS[org.status].label}`} />
      <div className="space-y-6">
        <Card className="space-y-3 p-6">
          <h2 className="font-display text-lg font-bold">Conta de recebimento</h2>
          <p className="text-sm">
            Status: <Badge variant={org.paymentAccountStatus === "CONNECTED" ? "success" : org.paymentAccountStatus === "SIMULATED" ? "warning" : "default"}>{PAYMENT_ACCOUNT_STATUS[org.paymentAccountStatus]}</Badge>
          </p>
          {adapter.isSimulated ? (
            <Alert variant="warning">
              Ambiente de desenvolvimento: pagamentos usam o provedor simulado. A conexão real (OAuth do Mercado Pago com split de marketplace) será habilitada após verificação dos contratos de API.
            </Alert>
          ) : (
            <Alert>A conexão com o provedor real ainda não está disponível nesta versão.</Alert>
          )}
          {org.status === "APPROVED" && org.paymentAccountStatus === "NOT_CONNECTED" && <ConnectPaymentButton simulated={adapter.isSimulated} />}
          {v && (
            <p className="text-xs text-muted-foreground">
              Documento cadastrado: {v.documentType} final {v.documentLast4} · {v.legalName}
            </p>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 font-display text-lg font-bold">Perfil público</h2>
          <ProfileSettingsForm description={org.description ?? ""} websiteUrl={org.websiteUrl ?? ""} instagramHandle={org.instagramHandle ?? ""} />
        </Card>

        {can("members:manage") && (
          <Card className="space-y-5 p-6">
            <h2 className="font-display text-lg font-bold">Equipe</h2>
            <ul className="divide-y divide-border rounded-2xl border border-border">
              {org.members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span>
                    <strong>{m.user.name}</strong> <span className="text-muted-foreground">{m.user.email}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge>{ORG_ROLE[m.role]}</Badge>
                    {m.role !== "OWNER" && <RemoveMemberButton userId={m.user.id} />}
                  </span>
                </li>
              ))}
            </ul>
            {org.invitations.length > 0 && (
              <p className="text-xs text-muted-foreground">Convites pendentes: {org.invitations.map((i) => `${i.email} (${ORG_ROLE[i.role]})`).join(", ")}</p>
            )}
            <InviteForm events={events.map((e) => ({ id: e.id, title: e.title }))} />

            {staff.length > 0 && events.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-bold">Atribuição da equipe de check-in por evento</h3>
                <div className="overflow-x-auto rounded-2xl border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="p-3">Evento</th>
                        {staff.map((s) => (
                          <th key={s.id} className="p-3">
                            {s.user.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {events.map((e) => (
                        <tr key={e.id} className="border-t border-border">
                          <td className="p-3">{e.title}</td>
                          {staff.map((s) => (
                            <td key={s.id} className="p-3">
                              <StaffAssignmentToggle eventId={e.id} userId={s.user.id} assigned={e.staffAssignments.some((a) => a.userId === s.user.id)} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
