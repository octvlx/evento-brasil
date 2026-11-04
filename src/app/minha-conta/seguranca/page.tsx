import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { TwoFactorManager } from "@/features/auth/two-factor-manager";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { twoFactorStatus } from "@/server/services/two-factor";

export const metadata: Metadata = { title: "Segurança da conta", robots: { index: false } };

export default function SecurityPage({ searchParams }: PageProps<"/minha-conta/seguranca">) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/minha-conta" className="text-sm font-semibold text-secondary underline">
        ← Minha conta
      </Link>
      <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight">Segurança da conta</h1>
      <Suspense fallback={<Skeleton className="mt-6 h-64" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Content({ searchParams }: { searchParams: PageProps<"/minha-conta/seguranca">["searchParams"] }) {
  const user = await requireUser("/minha-conta/seguranca");
  const [{ exigido }, status] = await Promise.all([searchParams, twoFactorStatus(db, user.id)]);
  const enabledAtLabel = status.enabledAt
    ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "America/Sao_Paulo" }).format(status.enabledAt)
    : null;
  return (
    <div className="mt-6 space-y-6">
      {exigido && !status.enabled && (
        <Alert variant="warning" role="alert">
          Para acessar a área de administração ou de dono de organização, ative antes a verificação em duas etapas.
        </Alert>
      )}
      <Card className="space-y-4 p-6" data-testid="two-factor">
        <div>
          <h2 className="font-display text-lg font-bold">Verificação em duas etapas</h2>
          {status.privileged && (
            <p className="mt-1 text-sm text-muted-foreground">
              Sua conta administra uma organização ou a plataforma, por isso a verificação em duas etapas é {status.required ? "obrigatória" : "fortemente recomendada"}.
            </p>
          )}
        </div>
        <TwoFactorManager
          view={{
            enabled: status.enabled,
            enabledAtLabel,
            recoveryCodesRemaining: status.recoveryCodesRemaining,
            required: status.required,
            privileged: status.privileged,
            hasPassword: status.hasPassword,
          }}
        />
      </Card>
    </div>
  );
}
