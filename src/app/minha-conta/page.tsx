import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Download } from "lucide-react";
import { Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { ProfileForm } from "@/features/auth/profile-form";
import { logoutAction } from "@/features/auth/actions";
import { requireUser } from "@/server/auth/current";
import { formatPhoneBR } from "@/lib/br";

export const metadata: Metadata = { title: "Minha conta", robots: { index: false } };

export default function AccountPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">Minha conta</h1>
      <Suspense fallback={<Skeleton className="mt-6 h-72" />}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requireUser("/minha-conta");
  return (
    <div className="mt-6 space-y-6">
      <Card className="p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Dados pessoais</h2>
        <ProfileForm name={user.name} email={user.email} phone={user.phone ? formatPhoneBR(user.phone) : ""} />
      </Card>
      <Card className="space-y-3 p-6">
        <h2 className="font-display text-lg font-bold">Privacidade (LGPD)</h2>
        <p className="text-sm text-muted-foreground">
          Guardamos apenas o necessário para emitir e validar seus ingressos: nome, e-mail, celular (opcional) e histórico de pedidos. Não armazenamos dados de cartão — eles ficam com o provedor de pagamento.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {/* Download de arquivo (route handler), não navegação: <a> simples. */}
          <a href="/api/minha-conta/dados" download className={buttonVariants({ variant: "outline" })}>
            <Download aria-hidden /> Baixar meus dados
          </a>
          <span className="text-xs text-muted-foreground">Arquivo JSON com perfil, pedidos, ingressos, transferências e aceites de termos.</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Para corrigir ou excluir seus dados, use o canal indicado na{" "}
          <Link href="/privacidade" className="text-secondary underline">
            política de privacidade
          </Link>
          . Registros fiscais e financeiros podem precisar ser mantidos pelo prazo legal.
        </p>
      </Card>
      <div className="flex flex-wrap gap-3">
        <Link href="/meus-ingressos" className={buttonVariants({ variant: "outline" })}>
          Meus ingressos
        </Link>
        <Link href="/meus-pedidos" className={buttonVariants({ variant: "outline" })}>
          Meus pedidos
        </Link>
        <form action={logoutAction}>
          <button className={buttonVariants({ variant: "ghost", className: "text-destructive" })}>Sair da conta</button>
        </form>
      </div>
    </div>
  );
}
