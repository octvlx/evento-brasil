"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { deleteAccountAction } from "./actions";

/** Conta criada pelo Google não tem senha conhecida: confirma digitando o e-mail. */
export function DeleteAccountForm({ confirmWithEmail }: { confirmWithEmail: boolean }) {
  const [state, action, pending] = useActionState(deleteAccountAction, undefined);
  const [understood, setUnderstood] = useState(false);
  return (
    <form action={action} className="space-y-3">
      {confirmWithEmail ? (
        <div>
          <Label htmlFor="delete-email">Digite o e-mail da conta para confirmar</Label>
          <Input id="delete-email" name="email" type="email" required autoComplete="off" className="mt-1.5" />
        </div>
      ) : (
        <div>
          <Label htmlFor="delete-password">Senha</Label>
          <Input id="delete-password" name="password" type="password" required autoComplete="current-password" className="mt-1.5" />
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="mt-1" />
        Entendo que a exclusão é definitiva: não vou mais conseguir entrar nem recuperar esta conta.
      </label>
      {state?.error && <Alert variant="danger">{state.error}</Alert>}
      <Button variant="destructive" disabled={pending || !understood}>
        {pending ? "Excluindo…" : "Excluir minha conta"}
      </Button>
    </form>
  );
}
