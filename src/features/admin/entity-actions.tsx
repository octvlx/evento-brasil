// Ações do admin sobre evento, organização e usuário: as mesmas na lista e na página de
// detalhe. Cada ação revalida a permissão no servidor (features/admin/actions.ts).
import type { AdminRole, EventStatus, OrganizationStatus, UserStatus } from "@/generated/prisma/client";
import { AdminActionButton, AdminRolesEditor, DeleteAccountButton, DeleteOrganizationButton, RejectOrganizationButton, ResetTwoFactorButton } from "@/features/admin/controls";
import {
  adminCancelEventAction,
  autoPublishAction,
  deleteOrganizationAction,
  deleteUserAccountAction,
  featureEventAction,
  moderateEventAction,
  resetUserTwoFactorAction,
  rejectOrganizationDeletionAction,
  reviewOrganizationAction,
  setAdminRolesAction,
  suspendEventAction,
  suspendOrganizationAction,
  suspendUserAction,
} from "@/features/admin/actions";
import { ADMIN_ROLE_LABELS, ADMIN_ROLES, adminHas } from "@/server/auth/admin-roles";

/** `status`: o efetivo (effectiveEventStatus), para não oferecer ação a evento já terminado. */
export function EventAdminActions({ e }: { e: { id: string; status: EventStatus; rawStatus: EventStatus; suspendedAt: Date | null; isFeatured: boolean } }) {
  return (
    <div className="flex flex-wrap gap-2">
      {e.rawStatus === "PENDING_REVIEW" && (
        <>
          <AdminActionButton label="Aprovar" variant="secondary" action={moderateEventAction.bind(null, e.id, "APPROVE")} />
          <AdminActionButton label="Devolver" askReason="O que precisa ser ajustado?" reasonRequired action={moderateEventAction.bind(null, e.id, "REJECT")} />
        </>
      )}
      {e.suspendedAt && (
        <AdminActionButton
          label="Reativar"
          variant="secondary"
          confirm="O evento volta para a vitrine e as vendas são retomadas. O organizador é avisado."
          action={suspendEventAction.bind(null, e.id, false)}
        />
      )}
      {e.status === "PUBLISHED" && !e.suspendedAt && (
        <AdminActionButton
          label="Suspender"
          variant="outline"
          askReason="Motivo da suspensão (vai para o organizador)"
          reasonRequired
          confirm="Tira o evento da vitrine e pausa as vendas, sem cancelar nem reembolsar. Os ingressos já vendidos continuam valendo e o organizador não edita até a reativação."
          action={suspendEventAction.bind(null, e.id, true)}
        />
      )}
      {e.status === "PUBLISHED" && (
        <>
          {!e.suspendedAt && <AdminActionButton label={e.isFeatured ? "Remover destaque" : "Destacar"} action={featureEventAction.bind(null, e.id, !e.isFeatured)} />}
          <AdminActionButton
            label="Cancelar"
            variant="destructive"
            askReason="Motivo do cancelamento"
            reasonRequired
            confirm="Cancela o evento e reembolsa todos os pedidos pagos."
            action={adminCancelEventAction.bind(null, e.id)}
          />
        </>
      )}
    </div>
  );
}

export function OrganizationAdminActions({ o }: { o: { id: string; status: OrganizationStatus; autoPublishEvents: boolean; deletedAt: Date | null } }) {
  // Excluída: nada a decidir (nem reativar).
  if (o.deletedAt) return null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      {o.status === "PENDING_REVIEW" && (
        <>
          <AdminActionButton label="Aprovar" variant="secondary" action={reviewOrganizationAction.bind(null, o.id, "APPROVE")} />
          <RejectOrganizationButton action={reviewOrganizationAction.bind(null, o.id, "REJECT")} />
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
  );
}

/**
 * Exclusão da organização pelo superadmin (a página só mostra a quem tem
 * "organizers:delete"; a ação confere de novo). Com `requestId`, aprova o pedido do responsável.
 */
export function OrganizationDeleteAction({
  o,
  blockers,
  requestId = null,
}: {
  o: { id: string; name: string; events: number; members: number };
  blockers: string[];
  requestId?: string | null;
}) {
  return (
    <DeleteOrganizationButton
      organization={{ name: o.name, events: o.events, members: o.members }}
      blockers={blockers}
      label={requestId ? "Aprovar e excluir" : "Excluir organização"}
      action={deleteOrganizationAction.bind(null, o.id, requestId)}
    />
  );
}

/** Recusa do pedido de exclusão (motivo obrigatório, vai para o responsável). */
export function RejectOrganizationDeletionAction({ requestId }: { requestId: string }) {
  return (
    <AdminActionButton
      label="Recusar pedido"
      askReason="Motivo da recusa (vai para o responsável)"
      reasonRequired
      action={rejectOrganizationDeletionAction.bind(null, requestId)}
    />
  );
}

type AdminViewer = { id: string; adminRoles: AdminRole[] };
type ManagedUser = {
  id: string;
  name: string;
  email: string;
  platformRole: "USER" | "ADMIN";
  adminRoles: AdminRole[];
  status: UserStatus;
  anonymizedAt: Date | null;
  totpEnabledAt: Date | null;
  ordersCount: number;
  organizations: string[];
};

export function UserAdminActions({ u, admin }: { u: ManagedUser; admin: AdminViewer }) {
  if (u.id === admin.id || u.anonymizedAt) return null;
  const roleOptions = ADMIN_ROLES.map((r) => ({ value: r, ...ADMIN_ROLE_LABELS[r] }));
  return (
    <div className="flex flex-wrap items-start gap-2">
      {adminHas(admin.adminRoles, "admins:manage") && u.platformRole === "ADMIN" && (
        <AdminRolesEditor current={u.adminRoles} roles={roleOptions} action={setAdminRolesAction.bind(null, u.id)} />
      )}
      {u.totpEnabledAt && <ResetTwoFactorButton action={resetUserTwoFactorAction.bind(null, u.id)} />}
      {u.status === "ACTIVE" ? (
        <AdminActionButton label="Suspender" variant="destructive" askReason="Motivo" reasonRequired action={suspendUserAction.bind(null, u.id, true)} />
      ) : (
        <AdminActionButton label="Reativar" action={suspendUserAction.bind(null, u.id, false)} />
      )}
      {adminHas(admin.adminRoles, "users:delete") && u.platformRole !== "ADMIN" && (
        <DeleteAccountButton account={{ name: u.name, email: u.email, orders: u.ordersCount, organizations: u.organizations }} action={deleteUserAccountAction.bind(null, u.id)} />
      )}
    </div>
  );
}
