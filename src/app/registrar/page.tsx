import { GoogleAuthLink } from "@/features/auth/verification-panels";
import { googleConfigured } from "@/server/auth/google";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthShell } from "@/components/site/auth-shell";
import { Skeleton } from "@/components/ui/primitives";
import { RegisterForm } from "@/features/auth/register-form";

export const metadata: Metadata = { title: "Criar conta", robots: { index: false } };

export default function RegisterPage({ searchParams }: PageProps<"/registrar">) {
  return (
    <AuthShell
      title="Criar conta"
      subtitle="Leva menos de um minuto."
      footer={
        <>
          Já tem conta?{" "}
          <Suspense fallback={<Link href="/entrar">Entrar</Link>}><LoginLink searchParams={searchParams} /></Suspense>
        </>
      }
    >
      <Suspense fallback={<Skeleton className="h-96" />}>
        <WithNext searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function WithNext({ searchParams }: { searchParams: PageProps<"/registrar">["searchParams"] }) {
  const { next } = await searchParams;
  return <div className="space-y-4"><GoogleAuthLink enabled={googleConfigured()} next={typeof next === "string" ? next : undefined} /><RegisterForm next={typeof next === "string" ? next : undefined} /></div>;
}

async function LoginLink({ searchParams }: { searchParams: PageProps<"/registrar">["searchParams"] }) {
  const { next } = await searchParams;
  return <Link href={typeof next === "string" ? `/entrar?next=${encodeURIComponent(next)}` : "/entrar"} className="font-semibold text-secondary hover:underline">Entrar</Link>;
}
