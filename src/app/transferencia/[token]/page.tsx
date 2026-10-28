import type { Metadata } from "next";
import { Suspense } from "react";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { findTransferByToken } from "@/server/services/transfers";
import { formatEventDateTime } from "@/lib/datetime";
import { TransferResponse } from "@/features/checkin/transfer-response";

// Página mínima de aceite (Fase 3). A versão final é da Fase 4 (paginas-publicas,
// T-TRANSF-UI); o contrato está em docs/areas/check-in.md.
export const metadata: Metadata = { title: "Transferência de ingresso", robots: { index: false }, referrer: "no-referrer" };

export default function TransferPage({ params }: PageProps<"/transferencia/[token]">) {
  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <h1 className="font-display text-2xl font-extrabold tracking-tight">Transferência de ingresso</h1>
      <Suspense fallback={<Skeleton className="mt-6 h-64 rounded-3xl" />}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser(`/transferencia/${token}`);
  const now = new Date();
  const t = await findTransferByToken(db, token);
  if (!t) return <Alert variant="danger" className="mt-6">Link de transferência inválido.</Alert>;
  if (t.status !== "PENDING" || !t.expiresAt || t.expiresAt <= now) {
    const text = t.status === "ACCEPTED" ? "Esta transferência já foi aceita." : "Esta transferência não está mais disponível (expirou, foi cancelada ou recusada).";
    return <Alert className="mt-6">{text}</Alert>;
  }
  // Não mostra o ingresso a quem não é o destinatário indicado.
  if (user.email.toLowerCase() !== t.toEmail) {
    return (
      <Alert variant="warning" className="mt-6">
        Esta transferência foi enviada para outro e-mail. Entre com a conta desse e-mail para responder.
      </Alert>
    );
  }
  return (
    <Card className="mt-6 space-y-4 p-5">
      <p>
        <strong>{t.fromHolderName}</strong> quer transferir para você um ingresso <strong>{t.ticket.ticketType.name}</strong> de:
      </p>
      <div>
        <p className="font-display text-lg font-bold">{t.event.title}</p>
        <p className="text-sm text-muted-foreground first-letter:uppercase">{formatEventDateTime(t.event.startsAt, t.event.timezone)}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        A transferência é gratuita. Ao aceitar, o ingresso fica no seu nome ({t.toHolderName ?? user.name}) e ganha um novo QR code; o anterior deixa de valer.
        Válida até {formatEventDateTime(t.expiresAt, t.event.timezone)}.
      </p>
      <TransferResponse token={token} />
    </Card>
  );
}
