import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Badge, Card, Skeleton } from "@/components/ui/primitives";
import { PageTitle } from "@/components/site/panel-shell";
import {
  InviteForm,
  MemberRoleSelect,
  PendingInvitationActions,
  RemoveMemberButton,
  StaffAssignmentToggle,
} from "@/features/organizer/settings-forms";
import { db } from "@/server/db";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { SuspendedOrganizationNotice } from "@/features/organizer/suspended-notice";
import { assignableRoles, listPendingInvitations, MAX_PENDING_INVITATIONS, pendingOwnershipTransfer } from "@/server/services/organizers";
import { OwnershipTransferPanel } from "@/features/organizer/ownership-transfer";
import { formatDateTimeShort } from "@/lib/datetime";
import { ORG_ROLE } from "@/lib/labels";

export const metadata: Metadata = { title: "Equipe", robots: { index: false } };

export default function TeamPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[700px]" />}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const { user, membership, org, can } = await requireOrganizer("/organizador/equipe");
  if (!can("members:manage")) redirect("/organizador");
  if (org.status === "SUSPENDED") return <SuspendedOrganizationNotice organizationId={org.id} title="Equipe" blocked="convidar pessoas, mudar papéis ou transferir a responsabilidade" />;
  const [members, invitations, events] = await Promise.all([
    db.organizationMember.findMany({
      where: { organizationId: org.id },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    listPendingInvitations(db, user, org.id),
    db.event.findMany({
      where: { organizationId: org.id, status: { in: ["DRAFT", "PENDING_REVIEW", "PUBLISHED"] } },
      select: { id: true, title: true, staffAssignments: { select: { userId: true } } },
      orderBy: { startsAt: "asc" },
    }),
  ]);
  const isOwner = membership.role === "OWNER";
  const [transfer, me] = isOwner
    ? await Promise.all([pendingOwnershipTransfer(db, user, org.id), db.user.findUniqueOrThrow({ where: { id: user.id }, select: { googleSubject: true } })])
    : [null, null];
  const activeInvitations = invitations.filter((i) => !i.expired).length;
  const roles = assignableRoles(membership.role);
  const staff = members.filter((m) => m.role === "CHECKIN_STAFF");

  return (
    <>
      <PageTitle title="Equipe" subtitle={org.name} />
      <Card className="space-y-5 p-6">
        <ul className="divide-y divide-border rounded-2xl border border-border">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" data-testid="team-member">
              <span>
                <strong>{m.user.name}</strong> <span className="text-muted-foreground">{m.user.email}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {/* Só mostra controles para quem o ator pode gerenciar; o servidor revalida. */}
                {roles.includes(m.role) ? <MemberRoleSelect userId={m.user.id} role={m.role} options={roles} /> : <Badge>{ORG_ROLE[m.role]}</Badge>}
                {roles.includes(m.role) && m.user.id !== user.id && <RemoveMemberButton userId={m.user.id} />}
              </span>
            </li>
          ))}
        </ul>

        <div>
          <h3 className="mb-2 text-sm font-bold">Convites pendentes</h3>
          {invitations.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum convite pendente.</p>
          ) : (
            <ul className="divide-y divide-border rounded-2xl border border-border">
              {invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" data-testid="pending-invitation">
                  <span className="space-y-0.5">
                    <span className="block">
                      <strong>{i.email}</strong> <Badge>{ORG_ROLE[i.role]}</Badge> {i.expired && <Badge variant="warning">Expirado</Badge>}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {i.eventTitle ? `${i.eventTitle} · ` : ""}
                      {i.invitedByName ? `convidado por ${i.invitedByName} · ` : ""}
                      {i.expired ? "venceu em" : "válido até"} {formatDateTimeShort(i.expiresAt)}
                    </span>
                  </span>
                  {roles.includes(i.role) && <PendingInvitationActions invitationId={i.id} />}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="invitation-limit">
          {activeInvitations} de {MAX_PENDING_INVITATIONS} convites ativos. Convites vencidos não contam.
        </p>
        <InviteForm events={events.map((e) => ({ id: e.id, title: e.title }))} roles={roles} />

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
        {isOwner && (
          <div className="border-t border-border pt-5">
            <OwnershipTransferPanel
              members={members.filter((m) => m.role !== "OWNER" && m.user.id !== user.id).map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email }))}
              pending={transfer && { toName: transfer.toName, toEmail: transfer.toEmail, expiresAt: transfer.expiresAt }}
              needsPassword={!me?.googleSubject}
            />
          </div>
        )}
      </Card>
    </>
  );
}
