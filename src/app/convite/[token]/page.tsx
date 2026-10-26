import type { Metadata } from "next";
import { Suspense } from "react";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { AcceptInvitation } from "@/features/organizer/accept-invitation";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { getInvitationForInvitee } from "@/server/services/organizers";
import { formatDateTimeShort } from "@/lib/datetime";
import { ORG_ROLE } from "@/lib/labels";

export const metadata: Metadata = { title: "Convite", robots: { index: false } };

export default function InvitationPage({ params }: PageProps<"/convite/[token]">) {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Suspense fallback={<Skeleton className="h-48" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser(`/convite/${token}`);
  const invitation = await getInvitationForInvitee(db, user, token);
  return (
    <Card className="space-y-4 p-6 text-center">
      <h1 className="font-display text-2xl font-extrabold">Convite para equipe</h1>
      {!invitation ? (
        <Alert variant="danger">Este convite é inválido, expirou, foi revogado ou substituído por um link mais recente.</Alert>
      ) : !invitation.emailMatches ? (
        <Alert variant="danger">
          Você está conectado como <strong>{user.email}</strong>, mas este convite foi enviado para outro e-mail. Entre com a conta convidada para aceitar ou recusar.
        </Alert>
      ) : (
        <>
          <p className="text-sm">
            <strong>{invitation.organizationName}</strong> convidou você como <strong>{ORG_ROLE[invitation.role]}</strong>
            {invitation.eventTitle ? ` no evento ${invitation.eventTitle}` : ""}.
          </p>
          <p className="text-xs text-muted-foreground">
            Conectado como {user.email} · válido até {formatDateTimeShort(invitation.expiresAt)}
          </p>
          <AcceptInvitation token={token} />
        </>
      )}
    </Card>
  );
}
