import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AuthShell } from "@/components/site/auth-shell";
import { Skeleton } from "@/components/ui/primitives";
import { MfaLoginForm } from "@/features/auth/mfa-login-form";
import { getPendingMfaSession, safeNext } from "@/server/auth/current";

export const metadata: Metadata = { title: "Verificação em duas etapas", robots: { index: false } };

export default function MfaVerificationPage({ searchParams }: PageProps<"/entrar/verificacao">) {
  return (
    <AuthShell title="Verificação em duas etapas" subtitle="Sua senha está correta. Falta o código do aplicativo autenticador.">
      <Suspense fallback={<Skeleton className="h-56" />}>
        <Verification searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function Verification({ searchParams }: { searchParams: PageProps<"/entrar/verificacao">["searchParams"] }) {
  const { next } = await searchParams;
  const target = safeNext(typeof next === "string" ? next : undefined);
  // Sem sessão pendente (expirou, já verificou ou nunca começou): volta ao login.
  if (!(await getPendingMfaSession())) redirect(`/entrar?next=${encodeURIComponent(target)}`);
  return <MfaLoginForm next={target} />;
}
