import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, Skeleton } from "@/components/ui/primitives";
import { AcceptInvitation } from "@/features/organizer/accept-invitation";
import { requireUser } from "@/server/auth/current";

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
  return (
    <Card className="space-y-4 p-6 text-center">
      <h1 className="font-display text-2xl font-extrabold">Convite para equipe</h1>
      <p className="text-sm text-muted-foreground">
        Você está conectado como <strong>{user.email}</strong>. O convite só pode ser aceito pelo e-mail para o qual foi enviado.
      </p>
      <AcceptInvitation token={token} />
    </Card>
  );
}
