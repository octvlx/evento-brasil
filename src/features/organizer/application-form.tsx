"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Alert, FieldError, Input, Label, Select, Textarea } from "@/components/ui/primitives";
import { organizerApplicationSchema, type OrganizerApplicationInput } from "@/features/schemas";
import { createOrganizationAction, resubmitApplicationAction } from "./actions";

/** `resubmitOrganizationId` presente = reenvio de cadastro recusado; ausente = nova organização. */
export function ApplicationForm({
  cities,
  defaults,
  resubmitOrganizationId,
}: {
  cities: { id: string; label: string }[];
  defaults?: Partial<OrganizerApplicationInput>;
  resubmitOrganizationId?: string;
}) {
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
      const res = resubmitOrganizationId ? await resubmitApplicationAction(resubmitOrganizationId, values) : await createOrganizationAction(values);
      if (res.ok) {
        router.push("/organizador");
        router.refresh();
      } else setError(res.error);
    }),
  );

  return (
    <form onSubmit={onSubmit} className="grid gap-5 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2 rounded-xl bg-muted p-4 text-sm">
        <p className="font-semibold">Identificação do organizador</p>
        <p className="mt-1 text-muted-foreground">
          Sua conta de comprador já está criada. Estes dados identificam a pessoa ou empresa responsável pela organização e são analisados separadamente.
        </p>
      </div>
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
          Usado na análise do organizador, separado do cadastro de comprador. Armazenamos o documento cifrado e mostramos apenas os últimos dígitos neste cadastro.
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
          A aprovação deste cadastro permite organizar eventos na plataforma. Para receber pagamentos, o provedor fará sua própria verificação de identidade e poderá solicitar dados e documentos adicionais. A aprovação da plataforma não substitui essa verificação.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Ao enviar, você aceita os <Link href="/termos" target="_blank" className="text-secondary underline">termos para organizadores</Link> em nome da organização.
        </p>
      </div>
    </form>
  );
}
