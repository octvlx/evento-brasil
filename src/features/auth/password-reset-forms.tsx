"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import {
  requestPasswordResetAction,
  resetPasswordAction,
} from "./password-reset-actions";
import { PasswordChecklist, PasswordInput } from "./password-fields";
import { PASSWORD_MESSAGES, passwordIssues } from "@/lib/password-policy";

export function ForgotPasswordForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        const email = String(
          new FormData(event.currentTarget).get("email") ?? "",
        );
        start(async () => {
          setError("");
          try {
            await requestPasswordResetAction(email);
            router.push("/email-enviado");
          } catch {
            setError(
              "Não foi possível enviar sua solicitação. Confira a conexão e tente novamente.",
            );
          }
        });
      }}
    >
      <div>
        <Label htmlFor="recovery-email">E-mail da sua conta</Label>
        <Input
          id="recovery-email"
          name="email"
          type="email"
          autoComplete="email"
          maxLength={200}
          required
          className="mt-1.5"
          disabled={pending}
        />
      </div>
      {error && (
        <div role="alert">
          <Alert variant="danger">{error}</Alert>
        </div>
      )}
      <Button className="w-full" size="lg" disabled={pending}>
        {pending ? "Solicitando…" : "Enviar link de recuperação"}
      </Button>
      <p className="text-sm text-muted-foreground">
        Se você usa apenas o Google, continue entrando pelo botão Google na
        página de login.
      </p>
    </form>
  );
}

function subscribeHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function ResetPasswordForm() {
  const token = useSyncExternalStore(
    subscribeHash,
    () => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "",
    () => "",
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [password, setPassword] = useState("");
  if (success)
    return (
      <div role="status" className="space-y-4">
        <Alert variant="success">
          Senha redefinida com sucesso! Você já pode entrar com sua nova senha.
        </Alert>
        <Link href="/entrar" className={buttonVariants({ className: "w-full", size: "lg" })}>
          Entrar na minha conta
        </Link>
      </div>
    );
  return (
    <form
      className="space-y-4"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const password = String(values.get("password") ?? "");
        const confirmation = String(values.get("confirmation") ?? "");
        const [issue] = passwordIssues(password);
        if (issue) {
          setError(issue);
          return;
        }
        if (password !== confirmation) {
          setError(PASSWORD_MESSAGES.mismatch);
          return;
        }
        start(async () => {
          setError("");
          try {
            const result = await resetPasswordAction(token, password, confirmation);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            window.history.replaceState(null, "", window.location.pathname);
            setSuccess(true);
          } catch {
            setError(
              "Não foi possível redefinir sua senha. Confira a conexão e tente novamente.",
            );
          }
        });
      }}
    >
      {!token && (
        <Alert variant="warning">
          Abra o link completo recebido por e-mail para redefinir sua senha.
        </Alert>
      )}
      <div>
        <Label htmlFor="new-password">Nova senha</Label>
        <PasswordInput
          id="new-password"
          name="password"
          autoComplete="new-password"
          required
          className="mt-1.5"
          disabled={pending}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="new-password-rules"
        />
        <PasswordChecklist id="new-password-rules" password={password} />
      </div>
      <div>
        <Label htmlFor="confirm-password">Confirmar nova senha</Label>
        <PasswordInput
          id="confirm-password"
          name="confirmation"
          autoComplete="new-password"
          required
          className="mt-1.5"
          disabled={pending}
        />
      </div>
      {error && (
        <div role="alert">
          <Alert variant="danger">{error}</Alert>
        </div>
      )}
      <Button className="w-full" size="lg" disabled={pending || !token}>
        {pending ? "Redefinindo…" : "Redefinir minha senha"}
      </Button>
      <Link
        href="/esqueci-minha-senha"
        className="block text-sm font-semibold text-secondary underline"
      >
        Link expirou? Solicitar outro
      </Link>
    </form>
  );
}
