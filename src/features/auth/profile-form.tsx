"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Input, Label } from "@/components/ui/primitives";
import { updateProfileAction } from "./actions";

export function ProfileForm({ name, email, phone }: { name: string; email: string; phone: string }) {
  const [state, action, pending] = useActionState(updateProfileAction, undefined);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" value={email} disabled className="mt-1.5" />
      </div>
      <div>
        <Label htmlFor="name">Nome</Label>
        <Input id="name" name="name" defaultValue={name} required className="mt-1.5" autoComplete="name" />
      </div>
      <div>
        <Label htmlFor="phone">Celular</Label>
        <Input id="phone" name="phone" defaultValue={phone} placeholder="(11) 91234-5678" className="mt-1.5" inputMode="tel" autoComplete="tel-national" />
      </div>
      {state?.error && <Alert variant="danger" className="sm:col-span-2">{state.error}</Alert>}
      {state?.ok && <Alert variant="success" className="sm:col-span-2">Dados atualizados.</Alert>}
      <div className="sm:col-span-2">
        <Button disabled={pending}>{pending ? "Salvando…" : "Salvar"}</Button>
      </div>
    </form>
  );
}
