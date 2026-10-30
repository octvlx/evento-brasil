import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/site/auth-shell";
import { ForgotPasswordForm } from "@/features/auth/password-reset-forms";

export const metadata: Metadata = { title: "Recuperar senha", robots: { index: false }, referrer: "no-referrer" };

export default function ForgotPasswordPage() {
  return <AuthShell title="Esqueci minha senha" subtitle="Enviaremos as instruções para recuperar o acesso." footer={<Link href="/entrar" className="font-semibold text-secondary underline">Voltar para entrar</Link>}><ForgotPasswordForm /></AuthShell>;
}
