import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Download } from "lucide-react";
import { Alert, Card, Skeleton } from "@/components/ui/primitives";
import { buttonVariants } from "@/components/ui/button";
import { ProfileForm } from "@/features/auth/profile-form";
import { DeleteAccountForm } from "@/features/auth/delete-account-form";
import { ChangePasswordForm } from "@/features/auth/change-password-form";
import { logoutAction } from "@/features/auth/actions";
import { requireUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { accountDeletionBlockers, DELETION_BLOCKER_TEXT } from "@/server/services/account-deletion";
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
  const [blockers, account] = await Promise.all([
    accountDeletionBlockers(db, user.id),
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { googleSubject: true, totpEnabledAt: true } }),
  ]);
  return (
    <div className="mt-6 space-y-6">
      <Card className="p-6">
        <h2 className="mb-4 font-display text-lg font-bold">Dados pessoais</h2>
        <ProfileForm name={user.name} email={user.email} phone={user.phone ? formatPhoneBR(user.phone) : ""} />
      </Card>
      <Card className="space-y-3 p-6" data-testid="account-security">
        <h2 className="font-display text-lg font-bold">Segurança da conta</h2>
        <h3 className="font-semibold">Alterar senha</h3>
        {account.googleSubject ? (
          <p className="text-sm text-muted-foreground">Você utiliza o Google para acessar sua conta.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Para proteger sua conta, informe sua senha atual e escolha uma nova senha.</p>
            <ChangePasswordForm />
            <p className="text-xs text-muted-foreground">Ao alterar a senha, as sessões abertas em outros dispositivos são encerradas.</p>
          </>
        )}
        <h3 className="pt-2 font-semibold">Verificação em duas etapas</h3>
        <p className="text-sm text-muted-foreground">
          {account.totpEnabledAt ? "Ativa: o login pede também um código do aplicativo autenticador." : "Desativada. Proteja sua conta com um código do celular além da senha."}
        </p>
        <Link href="/minha-conta/seguranca" className={buttonVariants({ variant: "outline", size: "sm" })}>
          {account.totpEnabledAt ? "Gerenciar verificação em duas etapas" : "Ativar verificação em duas etapas"}
        </Link>
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
          Para corrigir dados que não estão no formulário acima, use o canal indicado na{" "}
          <Link href="/privacidade" className="text-secondary underline">
            política de privacidade
          </Link>
          .
        </p>
      </Card>
      <Card className="space-y-3 border-destructive/30 p-6" data-testid="delete-account">
        <h2 className="font-display text-lg font-bold">Excluir minha conta</h2>
        <p className="text-sm text-muted-foreground">
          Apagamos seu nome, e-mail, celular, CPF, endereço e sessões, e tiramos seu nome dos pedidos e ingressos. Valores, datas e status das compras continuam guardados de forma anônima pelo prazo legal, assim como o histórico de transferências e os registros de auditoria.
        </p>
        {blockers.length ? (
          <Alert variant="warning">
            <p className="font-semibold">Ainda não dá para excluir a conta:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {blockers.map((b) => (
                <li key={b}>{DELETION_BLOCKER_TEXT[b]}</li>
              ))}
            </ul>
          </Alert>
        ) : (
          <DeleteAccountForm confirmWithEmail={Boolean(account.googleSubject)} />
        )}
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
