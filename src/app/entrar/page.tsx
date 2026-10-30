import { GoogleAuthLink } from "@/features/auth/verification-panels";
import { googleConfigured } from "@/server/auth/google";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthShell } from "@/components/site/auth-shell";
import { Skeleton } from "@/components/ui/primitives";
import { LoginForm } from "@/features/auth/login-form";

export const metadata: Metadata = { title: "Entrar", robots: { index: false } };

export default function LoginPage({ searchParams }: PageProps<"/entrar">) {
  return (
    <AuthShell
      title="Entrar"
      subtitle="Acesse seus ingressos e pedidos."
      footer={
        <>
          Não tem conta?{" "}
          <Suspense fallback={<Link href="/registrar" className="font-semibold text-secondary">Criar conta</Link>}>
            <RegisterLink searchParams={searchParams} />
          </Suspense>
        </>
      }
    >
      <Suspense fallback={<Skeleton className="h-64" />}>
        <LoginWithNext searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function LoginWithNext({ searchParams }: { searchParams: PageProps<"/entrar">["searchParams"] }) {
  const { next, googleError } = await searchParams;
  return <div className="space-y-4">{googleError && <p role="alert" className="text-sm text-destructive">{googleError === "existing" ? "Este e-mail já tem uma conta. Entre usando sua senha; não vinculamos contas automaticamente." : "Não foi possível entrar com Google. Tente novamente ou use e-mail e senha."}</p>}<GoogleAuthLink enabled={googleConfigured()} next={typeof next === "string" ? next : undefined} /><LoginForm next={typeof next === "string" ? next : undefined} /></div>;
}

async function RegisterLink({ searchParams }: { searchParams: PageProps<"/entrar">["searchParams"] }) {
  const { next } = await searchParams;
  const href = typeof next === "string" ? `/registrar?next=${encodeURIComponent(next)}` : "/registrar";
  return (
    <Link href={href} className="font-semibold text-secondary hover:underline">
      Criar conta
    </Link>
  );
}
