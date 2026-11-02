"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Label } from "@/components/ui/primitives";
import { PASSWORD_MESSAGES } from "@/lib/password-policy";
import { changePasswordAction } from "./actions";
import { PasswordChecklist, PasswordInput } from "./password-fields";

/** Alterar senha em Minha conta: senha atual obrigatória; o servidor revalida tudo. */
export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const mismatch = confirm.length > 0 && confirm !== newPassword;

  // Sucesso: limpa os três campos (o formulário é reiniciado pelo navegador).
  useEffect(() => {
    if (!state?.ok) return;
    formRef.current?.reset();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- espelha o reset do formulário
    setNewPassword("");
    setConfirm("");
  }, [state]);

  return (
    <form ref={formRef} action={action} className="space-y-4" aria-busy={pending}>
      <div>
        <Label htmlFor="current-password">Senha atual</Label>
        <PasswordInput
          id="current-password"
          name="currentPassword"
          autoComplete="current-password"
          required
          className="mt-1.5"
          aria-invalid={state?.field === "currentPassword"}
          aria-describedby={state?.field === "currentPassword" ? "change-password-error" : undefined}
        />
      </div>
      <div>
        <Label htmlFor="new-account-password">Nova senha</Label>
        <PasswordInput
          id="new-account-password"
          name="newPassword"
          autoComplete="new-password"
          required
          className="mt-1.5"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          aria-describedby="new-account-password-rules"
        />
        <PasswordChecklist id="new-account-password-rules" password={newPassword} />
      </div>
      <div>
        <Label htmlFor="confirm-account-password">Confirmar nova senha</Label>
        <PasswordInput
          id="confirm-account-password"
          name="confirmPassword"
          autoComplete="new-password"
          required
          className="mt-1.5"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={mismatch}
          aria-describedby={mismatch ? "confirm-account-password-error" : undefined}
        />
        {mismatch && (
          <p id="confirm-account-password-error" className="mt-1.5 text-xs font-medium text-destructive">
            {PASSWORD_MESSAGES.newMismatch}
          </p>
        )}
      </div>
      <div aria-live="polite">
        {state?.error && (
          <Alert variant="danger" id="change-password-error">
            {state.error}
          </Alert>
        )}
        {state?.ok && <Alert variant="success">Sua senha foi alterada com sucesso.</Alert>}
      </div>
      <Button disabled={pending || mismatch}>{pending ? "Alterando…" : "Alterar senha"}</Button>
    </form>
  );
}
