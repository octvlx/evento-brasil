import type { Metadata } from "next";
import { Suspense } from "react";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { OwnershipTransferResponse } from "@/features/organizer/ownership-transfer";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { getOwnershipTransferForRecipient } from "@/server/services/organizers";
import { formatDateTimeShort } from "@/lib/datetime";

export const metadata: Metadata = { title: "Transferência de responsável", robots: { index: false } };

export default function OwnershipTransferPage({ params }: PageProps<"/organizador/propriedade/[token]">) {
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
  const user = await requireUser(`/organizador/propriedade/${token}`);
  const t = await getOwnershipTransferForRecipient(db, user, token);
  return (
    <Card className="space-y-4 p-6 text-center">
      <h1 className="font-display text-2xl font-extrabold">Transferência de responsável</h1>
      {!t ? (
        <Alert variant="danger">Este pedido é inválido, expirou, foi cancelado ou já foi respondido.</Alert>
      ) : !t.forMe ? (
        <Alert variant="danger">
          Você está conectado como <strong>{user.email}</strong>, mas este pedido é para outra conta. Entre com a conta indicada para responder.
        </Alert>
      ) : (
        <>
          <p className="text-sm">
            {t.fromName ? <strong>{t.fromName}</strong> : "O responsável atual"} quer passar a organização <strong>{t.organizationName}</strong> para você.
          </p>
          <p className="text-xs text-muted-foreground">
            Ao aceitar, você vira o responsável (OWNER) e quem pediu continua como administrador. Válido até {formatDateTimeShort(t.expiresAt)}.
          </p>
          <OwnershipTransferResponse token={token} />
        </>
      )}
    </Card>
  );
}
