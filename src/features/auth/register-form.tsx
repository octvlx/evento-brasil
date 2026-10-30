"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Alert, FieldError, Input, Label } from "@/components/ui/primitives";
import { registerSchema, type RegisterInput } from "@/features/schemas";
import { registerAction } from "./actions";

export function RegisterForm({ next }: { next?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const form = useForm<RegisterInput>({ resolver: zodResolver(registerSchema), defaultValues: { name: "", email: "", password: "", phone: "" } });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      const res = await registerAction({ ...values, phone: values.phone || undefined }, next);
      if (res.ok) {
        // A new authenticated document must not reuse the cached anonymous checkout redirect.
        window.location.assign(res.data.redirectTo);
      } else setError(res.error);
    }),
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <Label htmlFor="name">Nome completo</Label>
        <Input id="name" autoComplete="name" className="mt-1.5" aria-invalid={!!errors.name} {...form.register("name")} />
        <FieldError message={errors.name?.message} />
      </div>
      <div>
        <Label htmlFor="email">E-mail</Label>
        <Input id="email" type="email" autoComplete="email" className="mt-1.5" aria-invalid={!!errors.email} {...form.register("email")} />
        <FieldError message={errors.email?.message} />
      </div>
      <div>
        <Label htmlFor="phone">Celular (opcional)</Label>
        <Input id="phone" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="(11) 91234-5678" className="mt-1.5" aria-invalid={!!errors.phone} {...form.register("phone")} />
        <FieldError message={errors.phone?.message} />
      </div>
      <div>
        <Label htmlFor="password">Senha</Label>
        <Input id="password" type="password" autoComplete="new-password" className="mt-1.5" aria-invalid={!!errors.password} {...form.register("password")} />
        <FieldError message={errors.password?.message} />
      </div>
      <fieldset className="space-y-2">
        <legend className="sr-only">Aceites</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" aria-invalid={!!errors.acceptTerms} {...form.register("acceptTerms")} />
          <span>
            Li e aceito os{" "}
            <Link href="/termos" target="_blank" className="text-secondary underline">
              termos de uso
            </Link>
            .
          </span>
        </label>
        <FieldError message={errors.acceptTerms?.message} />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" aria-invalid={!!errors.acceptPrivacy} {...form.register("acceptPrivacy")} />
          <span>
            Li e aceito a{" "}
            <Link href="/privacidade" target="_blank" className="text-secondary underline">
              política de privacidade
            </Link>
            .
          </span>
        </label>
        <FieldError message={errors.acceptPrivacy?.message} />
      </fieldset>
      {error && <Alert variant="danger">{error}</Alert>}
      <Button className="w-full" size="lg" disabled={pending}>
        {pending ? "Criando conta…" : "Criar conta"}
      </Button>
    </form>
  );
}
