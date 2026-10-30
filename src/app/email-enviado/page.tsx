import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/site/auth-shell";

export const metadata: Metadata = { title: "Confira seu e-mail", robots: { index: false }, referrer: "no-referrer" };

export default function EmailSentPage() {
  return <AuthShell title="Confira seu e-mail" subtitle="Seu pedido foi recebido."><div className="space-y-4"><p role="status">Se este endereço estiver associado a uma conta com senha, enviaremos um link de recuperação. Confira também a caixa de spam.</p><p className="text-sm text-muted-foreground">O link tem validade limitada. Se não chegar, aguarde antes de solicitar novamente.</p><Link href="/esqueci-minha-senha" className="block font-semibold text-secondary underline">Solicitar outro link</Link><Link href="/entrar" className="block text-sm text-secondary underline">Voltar para entrar</Link></div></AuthShell>;
}
