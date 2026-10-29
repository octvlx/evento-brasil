"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Alert, FieldError, Input, Label } from "@/components/ui/primitives";
import { registerDetailsSchema, type RegisterDetailsInput } from "@/features/schemas";
import { registerAction, sendSignupPhoneCodeAction, verifySignupPhoneCodeAction } from "./actions";

export function RegisterForm({ next }: { next?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [code, setCode] = useState("");
  const [resendSeconds, setResendSeconds] = useState(0);
  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(() => setResendSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);

  function clearVerification() {
    setChallengeToken(null);
    setVerified(false);
    setCode("");
    setError(null);
  }
  const form = useForm<RegisterDetailsInput>({ resolver: zodResolver(registerDetailsSchema), defaultValues: { name: "", email: "", password: "", phone: "" } });
  const { errors } = form.formState;

  async function sendCode(values: RegisterDetailsInput) {
    const res = await sendSignupPhoneCodeAction({ email: values.email, phone: values.phone, smsConsent: values.smsConsent });
    if (res.ok) {
      setChallengeToken(res.data.challengeToken);
      setVerified(false);
      setCode("");
      setResendSeconds(res.data.resendAfterSeconds);
    } else setError(res.error);
  }

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      setError(null);
      if (!challengeToken) return sendCode(values);
      if (!verified) {
        const res = await verifySignupPhoneCodeAction({ email: values.email, phone: values.phone, challengeToken, code });
        if (res.ok) setVerified(true);
        else setError(res.error);
        return;
      }
      const res = await registerAction({ ...values, phoneVerificationToken: challengeToken }, next);
      if (res.ok) {
        router.push(res.data.redirectTo);
        router.refresh();
      } else setError(res.error);
    }),
  );

  const resendCode = form.handleSubmit((values) => start(async () => {
    setError(null);
    await sendCode(values);
  }));

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate aria-busy={pending}>
      <fieldset disabled={pending} className="space-y-4">
        <legend className="sr-only">Dados da conta</legend>
        <div>
          <Label htmlFor="name">Nome completo</Label>
          <Input id="name" autoComplete="name" className="mt-1.5" aria-invalid={!!errors.name} {...form.register("name")} />
          <FieldError message={errors.name?.message} />
        </div>
        <div>
          <Label htmlFor="email">E-mail</Label>
          <Input id="email" type="email" autoComplete="email" className="mt-1.5" aria-invalid={!!errors.email} {...form.register("email", { onChange: clearVerification })} />
          <FieldError message={errors.email?.message} />
        </div>
        <div>
          <Label htmlFor="phone">Celular</Label>
          <Input id="phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="(11) 91234-5678" className="mt-1.5" aria-invalid={!!errors.phone} {...form.register("phone", { onChange: clearVerification })} />
          <FieldError message={errors.phone?.message} />
        </div>
        <div>
          <Label htmlFor="password">Senha</Label>
          <Input id="password" type="password" autoComplete="new-password" className="mt-1.5" aria-invalid={!!errors.password} {...form.register("password")} />
          <FieldError message={errors.password?.message} />
        </div>
        <fieldset className="space-y-2">
          <legend className="sr-only">Aceites e verificação</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" aria-invalid={!!errors.smsConsent} {...form.register("smsConsent")} />
            <span>Autorizo receber SMS do Evento Brasil para verificar meu celular e proteger minha conta. Esta autorização não inclui mensagens de marketing. Podem ser aplicadas tarifas da operadora.</span>
          </label>
          <FieldError message={errors.smsConsent?.message} />
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
              Li e estou ciente da{" "}
              <Link href="/privacidade" target="_blank" className="text-secondary underline">
                política de privacidade
              </Link>
              .
            </span>
          </label>
          <FieldError message={errors.acceptPrivacy?.message} />
        </fieldset>
      </fieldset>
      <p className="text-sm text-muted-foreground">Enviaremos um código por SMS para confirmar seu celular. Dados de pagamento são solicitados no checkout; dados do organizador, no cadastro de produtor.</p>
      {challengeToken && !verified && (
        <div className="space-y-2">
          <p id="phone-code-help" role="status" className="text-sm text-muted-foreground">Código enviado para {form.getValues("phone")}. Confira o número e digite os 6 dígitos recebidos.</p>
          <Label htmlFor="phone-code">Código de verificação</Label>
          <Input id="phone-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-describedby="phone-code-help" disabled={pending} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" disabled={pending || resendSeconds > 0} onClick={() => void resendCode()}>
              {resendSeconds > 0 ? `Reenviar em ${resendSeconds}s` : "Reenviar código"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={clearVerification}>Alterar celular ou e-mail</Button>
          </div>
        </div>
      )}
      {verified && <p role="status" className="text-sm text-success">Celular verificado. Agora você pode criar sua conta.</p>}
      {error && <div role="alert"><Alert variant="danger">{error}</Alert></div>}
      <Button className="w-full" size="lg" disabled={pending}>
        {pending ? "Aguarde…" : !challengeToken ? "Enviar código por SMS" : !verified ? "Verificar celular" : "Criar conta"}
      </Button>
    </form>
  );
}
