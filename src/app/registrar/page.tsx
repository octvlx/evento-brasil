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
          <Link href="/entrar" className="font-semibold text-secondary hover:underline">
            Entrar
          </Link>
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
  return <RegisterForm next={typeof next === "string" ? next : undefined} />;
}
