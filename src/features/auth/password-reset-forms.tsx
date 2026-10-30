"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { requestPasswordResetAction, resetPasswordAction } from "./password-reset-actions";

export function ForgotPasswordForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  return (
    <form className="space-y-4" aria-busy={pending} onSubmit={event => {
      event.preventDefault();
      const email = String(new FormData(event.currentTarget).get("email") ?? "");
      start(async () => {
        setError("");
        try {
          await requestPasswordResetAction(email);
          router.push("/email-enviado");
        } catch {
          setError("Não foi possível enviar sua solicitação. Confira a conexão e tente novamente.");
        }
      });
    }}>
      <div>
        <Label htmlFor="recovery-email">E-mail da sua conta</Label>
        <Input id="recovery-email" name="email" type="email" autoComplete="email" maxLength={200} required className="mt-1.5" disabled={pending} />
      </div>
      {error && <div role="alert"><Alert variant="danger">{error}</Alert></div>}
      <Button className="w-full" size="lg" disabled={pending}>{pending ? "Solicitando…" : "Enviar link de recuperação"}</Button>
      <p className="text-sm text-muted-foreground">Se você usa apenas o Google, continue entrando pelo botão Google na página de login.</p>
    </form>
  );
}

function subscribeHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function ResetPasswordForm() {
  const token = useSyncExternalStore(subscribeHash, () => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "", () => "");
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  if (success) return <div role="status" className="space-y-4"><Alert>Sua senha foi redefinida. As sessões anteriores foram encerradas.</Alert><Link href="/entrar" className="font-semibold text-secondary underline">Entrar com a nova senha</Link></div>;
  return (
    <form className="space-y-4" aria-busy={pending} onSubmit={event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const password = String(values.get("password") ?? "");
      if (password !== values.get("confirmation")) { setError("As senhas precisam ser iguais."); return; }
      start(async () => {
        setError("");
        try {
          const result = await resetPasswordAction(token, password);
          if (!result.ok) { setError(result.error); return; }
          window.history.replaceState(null, "", window.location.pathname);
          setSuccess(true);
        } catch {
          setError("Não foi possível redefinir sua senha. Confira a conexão e tente novamente.");
        }
      });
    }}>
      {!token && <Alert variant="warning">Abra o link completo recebido por e-mail para redefinir sua senha.</Alert>}
      <div>
        <Label htmlFor="new-password">Nova senha</Label>
        <Input id="new-password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={200} required className="mt-1.5" disabled={pending} />
        <p className="mt-1 text-xs text-muted-foreground">Use pelo menos 8 caracteres.</p>
      </div>
      <div>
        <Label htmlFor="confirm-password">Confirme a nova senha</Label>
        <Input id="confirm-password" name="confirmation" type="password" autoComplete="new-password" minLength={8} maxLength={200} required className="mt-1.5" disabled={pending} />
      </div>
      {error && <div role="alert"><Alert variant="danger">{error}</Alert></div>}
      <Button className="w-full" size="lg" disabled={pending || !token}>{pending ? "Redefinindo…" : "Redefinir minha senha"}</Button>
      <Link href="/esqueci-minha-senha" className="block text-sm font-semibold text-secondary underline">Link expirou? Solicitar outro</Link>
    </form>
  );
}
