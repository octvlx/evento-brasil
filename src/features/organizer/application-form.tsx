"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Alert, FieldError, Input, Label, Select, Textarea } from "@/components/ui/primitives";
import { organizerApplicationSchema, type OrganizerApplicationInput } from "@/features/schemas";
import { submitApplicationAction } from "./actions";

export function ApplicationForm({ cities, defaults }: { cities: { id: string; label: string }[]; defaults?: Partial<OrganizerApplicationInput> }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const form = useForm<OrganizerApplicationInput>({
    resolver: zodResolver(organizerApplicationSchema),
    defaultValues: { legalType: "COMPANY", name: "", legalName: "", document: "", contactEmail: "", ...defaults },
  });
  const { errors } = form.formState;
  const legalType = useWatch({ control: form.control, name: "legalType" });

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      const res = await submitApplicationAction(values);
      if (res.ok) {
        router.push("/organizador");
        router.refresh();
      } else setError(res.error);
    }),
  );

  return (
    <form onSubmit={onSubmit} className="grid gap-5 sm:grid-cols-2" noValidate>
      <fieldset className="sm:col-span-2">
        <legend className="mb-2 text-sm font-medium">Tipo de cadastro</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["COMPANY", "Empresa (CNPJ)", "Produtora, casa de shows, agência"],
              ["INDIVIDUAL", "Pessoa física (CPF)", "Artista, coletivo informal, produtor independente"],
            ] as const
          ).map(([v, l, h]) => (
            <label key={v} className={`cursor-pointer rounded-2xl border p-4 ${legalType === v ? "border-secondary ring-2 ring-secondary/30" : "border-border"}`}>
              <input type="radio" value={v} className="sr-only" {...form.register("legalType")} />
              <span className="block font-semibold">{l}</span>
              <span className="text-xs text-muted-foreground">{h}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Label htmlFor="name">Nome público</Label>
        <Input id="name" className="mt-1.5" placeholder="Como aparecerá para o público" aria-invalid={!!errors.name} {...form.register("name")} />
        <FieldError message={errors.name?.message} />
      </div>
      <div>
        <Label htmlFor="legalName">{legalType === "COMPANY" ? "Razão social" : "Nome completo"}</Label>
        <Input id="legalName" className="mt-1.5" aria-invalid={!!errors.legalName} {...form.register("legalName")} />
        <FieldError message={errors.legalName?.message} />
      </div>
      <div>
        <Label htmlFor="document">{legalType === "COMPANY" ? "CNPJ" : "CPF"}</Label>
        <Input
          id="document"
          className="mt-1.5"
          inputMode="numeric"
          placeholder={legalType === "COMPANY" ? "00.000.000/0000-00" : "000.000.000-00"}
          aria-invalid={!!errors.document}
          aria-describedby="doc-help"
          {...form.register("document")}
        />
        <FieldError message={errors.document?.message} />
        <p id="doc-help" className="mt-1 text-xs text-muted-foreground">
          Necessário para repasses e obrigações fiscais. Armazenado cifrado; exibimos apenas os últimos dígitos.
        </p>
      </div>
      <div>
        <Label htmlFor="cityId">Cidade-sede</Label>
        <Select id="cityId" className="mt-1.5" {...form.register("cityId")}>
          <option value="">Selecione</option>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="contactEmail">E-mail de contato</Label>
        <Input id="contactEmail" type="email" className="mt-1.5" aria-invalid={!!errors.contactEmail} {...form.register("contactEmail")} />
        <FieldError message={errors.contactEmail?.message} />
      </div>
      <div>
        <Label htmlFor="contactPhone">Celular / WhatsApp</Label>
        <Input id="contactPhone" type="tel" className="mt-1.5" placeholder="(11) 91234-5678" aria-invalid={!!errors.contactPhone} {...form.register("contactPhone")} />
        <FieldError message={errors.contactPhone?.message} />
      </div>
      <div>
        <Label htmlFor="websiteUrl">Site (opcional)</Label>
        <Input id="websiteUrl" className="mt-1.5" placeholder="https://" aria-invalid={!!errors.websiteUrl} {...form.register("websiteUrl")} />
        <FieldError message={errors.websiteUrl?.message} />
      </div>
      <div>
        <Label htmlFor="instagramHandle">Instagram (opcional)</Label>
        <Input id="instagramHandle" className="mt-1.5" placeholder="@seuperfil" aria-invalid={!!errors.instagramHandle} {...form.register("instagramHandle")} />
        <FieldError message={errors.instagramHandle?.message} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="description">Sobre você ou sua organização</Label>
        <Textarea id="description" className="mt-1.5" {...form.register("description")} />
      </div>
      {error && (
        <Alert variant="danger" className="sm:col-span-2">
          {error}
        </Alert>
      )}
      <div className="sm:col-span-2">
        <Button size="lg" disabled={pending}>
          {pending ? "Enviando…" : "Enviar para análise"}
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          A equipe da plataforma analisa o cadastro. A verificação de identidade para recebimentos é feita pelo provedor de pagamento na conexão da conta.
        </p>
      </div>
    </form>
  );
}
