"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { cancelMfaLoginAction, verifyMfaLoginAction } from "./two-factor-actions";

/** Segunda etapa do login: código do aplicativo autenticador ou de recuperação. */
export function MfaLoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(verifyMfaLoginAction, undefined);
  const [recovery, setRecovery] = useState(false);
  if (state?.expired)
    return (
      <div className="space-y-4">
        <Alert variant="danger">{state.error}</Alert>
        <Link href={`/entrar${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="block text-center text-sm font-semibold text-secondary underline">
          Voltar para o login
        </Link>
      </div>
    );
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4" aria-busy={pending}>
        <input type="hidden" name="next" value={next ?? ""} />
        <div>
          <Label htmlFor="mfa-code">{recovery ? "Código de recuperação" : "Código de 6 dígitos"}</Label>
          <Input
            key={recovery ? "recovery" : "totp"}
            id="mfa-code"
            name="code"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode={recovery ? "text" : "numeric"}
            pattern={recovery ? undefined : "[0-9 ]{6,7}"}
            maxLength={recovery ? 11 : 7}
            placeholder={recovery ? "XXXXX-XXXXX" : "123456"}
            className="mt-1.5 text-center font-mono text-lg tracking-widest"
            aria-describedby="mfa-code-help"
            aria-invalid={Boolean(state?.error)}
          />
          <p id="mfa-code-help" className="mt-1.5 text-sm text-muted-foreground">
            {recovery
              ? "Cada código de recuperação vale uma única vez."
              : "Abra o aplicativo autenticador e digite o código da QQPega."}
          </p>
        </div>
        {state?.error && <Alert variant="danger">{state.error}</Alert>}
        <Button className="w-full" size="lg" disabled={pending}>
          {pending ? "Verificando…" : "Verificar e entrar"}
        </Button>
      </form>
      <button type="button" onClick={() => setRecovery((r) => !r)} className="block w-full text-center text-sm font-semibold text-secondary underline">
        {recovery ? "Usar o código do aplicativo" : "Perdi o acesso ao aplicativo: usar um código de recuperação"}
      </button>
      <form action={cancelMfaLoginAction}>
        <button type="submit" className="block w-full text-center text-sm text-muted-foreground underline">
          Cancelar e sair
        </button>
      </form>
    </div>
  );
}
