"use client";

// Campos de cada etapa do assistente de evento (apresentação). Estado,
// navegação e salvamento ficam em `event-wizard.tsx`.
import { useState, type ReactNode } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import Link from "next/link";
import { ImagePlus, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/primitives";
import { BR_TIMEZONES } from "@/lib/br";
import { cn } from "@/lib/utils";
import { uploadCoverAction } from "./actions";
import type { WizardValues } from "./wizard-steps";

export type Errors = Record<string, string>;
type Form = UseFormReturn<WizardValues>;
type Name = Parameters<Form["register"]>[0];

export const fieldId = (name: string) => `ew-${name.replace(/\./g, "-")}`;

/** Rótulo, ajuda e erro ligados ao campo (aria-describedby / aria-invalid). */
function Field({ name, label, help, error, children, className }: { name: string; label: ReactNode; help?: ReactNode; error?: string; children: (a11y: A11y) => ReactNode; className?: string }) {
  const id = fieldId(name);
  const describedBy = [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      <div className="mt-1.5">
        {children({
          id,
          "aria-describedby": describedBy,
          "aria-invalid": !!error,
          "data-field": name,
        })}
      </div>
      {help && (
        <p id={`${id}-help`} className="mt-1.5 text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-destructive">
          <span aria-hidden>⚠ </span>
          {error}
        </p>
      )}
    </div>
  );
}
type A11y = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid": boolean;
  "data-field": string;
};

function Tip({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-xl bg-muted px-4 py-3 text-xs text-muted-foreground">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

/** Data e horário em campos separados, gravados como "AAAA-MM-DDTHH:mm" (horário local do evento). */
function DateTimeField({ form, name, label, help, error }: { form: Form; name: "startsAtLocal" | "endsAtLocal" | "salesStartLocal" | "salesEndLocal"; label: string; help?: string; error?: string }) {
  const value = (useWatch({ control: form.control, name }) as string) ?? "";
  const [date = "", time = ""] = value.split("T");
  const set = (d: string, t: string) => form.setValue(name, d || t ? `${d}T${t}` : "", { shouldDirty: true });
  const id = fieldId(name);
  const describedBy = [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <fieldset>
      <legend className="text-sm font-medium">{label}</legend>
      <div className="mt-1.5 grid grid-cols-[1fr_auto] gap-2">
        <div>
          <Label htmlFor={id} className="sr-only">
            {label}: data
          </Label>
          <Input id={id} type="date" data-field={name} value={date} aria-invalid={!!error} aria-describedby={describedBy} onChange={(e) => set(e.target.value, time)} />
        </div>
        <div>
          <Label htmlFor={`${id}-time`} className="sr-only">
            {label}: horário
          </Label>
          <Input id={`${id}-time`} type="time" className="w-32" value={time} aria-invalid={!!error} aria-describedby={describedBy} onChange={(e) => set(date, e.target.value)} />
        </div>
      </div>
      {help && (
        <p id={`${id}-help`} className="mt-1.5 text-xs text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-destructive">
          <span aria-hidden>⚠ </span>
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Valor inicial do campo (ou da opção marcada) já no HTML do servidor, antes da hidratação. */
function initialOf(form: Form, name: string): string {
  let v: unknown = form.formState.defaultValues;
  for (const k of name.split(".")) v = (v as Record<string, unknown> | undefined)?.[k];
  return typeof v === "string" ? v : "";
}
const reg = (form: Form, name: Name) => ({ ...form.register(name), defaultValue: initialOf(form, name) });
const radio = (form: Form, name: Name, value: string) => ({ ...form.register(name), value, defaultChecked: initialOf(form, name) === value });

// ── Etapa 1 ──
export function StepBasics({ form, errors, categories, organizationName }: { form: Form; errors: Errors; categories: { id: string; name: string }[]; organizationName: string }) {
  const summary = useWatch({ control: form.control, name: "summary" }) ?? "";
  return (
    <div className="grid gap-5">
      <Field name="title" label="Nome do evento" error={errors.title} help="Use o nome que o público vai procurar. Ex.: Festival de Jazz de Paraty 2026.">
        {(a) => <Input {...a} maxLength={140} autoComplete="off" {...reg(form, "title")} />}
      </Field>
      <Field name="categoryId" label="Categoria" error={errors.categoryId} help="Ajuda o público a encontrar o evento na busca e nas páginas de categoria.">
        {(a) => (
          <Select {...a} {...reg(form, "categoryId")}>
            <option value="">Selecione</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        name="summary"
        label="Resumo (opcional)"
        error={errors.summary}
        help={`Uma frase que aparece nos cards e no compartilhamento. Ex.: "Três noites de jazz ao ar livre no centro histórico." ${summary.length}/240`}
      >
        {(a) => <Input {...a} maxLength={240} {...reg(form, "summary")} />}
      </Field>
      <div>
        <p className="text-sm font-medium">Organização responsável</p>
        <p className="mt-1.5 rounded-xl border border-border bg-muted/50 px-3.5 py-2.5 text-sm">{organizationName}</p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          O evento será criado nesta organização.{" "}
          <Link href="/organizador/organizacoes" className="font-semibold text-secondary underline">
            Trocar de organização
          </Link>
        </p>
      </div>
    </div>
  );
}

// ── Etapa 2 ──
export function StepDateLocation({ form, errors, cities, venues }: { form: Form; errors: Errors; cities: { id: string; label: string }[]; venues: { id: string; label: string }[] }) {
  const locationType = useWatch({
    control: form.control,
    name: "locationType",
  });
  const venueMode = useWatch({ control: form.control, name: "venueMode" });
  const useNew = venueMode === "new" || venues.length === 0;
  return (
    <div className="grid gap-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <DateTimeField form={form} name="startsAtLocal" label="Início" error={errors.startsAtLocal} />
        <DateTimeField form={form} name="endsAtLocal" label="Término" error={errors.endsAtLocal} help="Precisa ser depois do início." />
        <Field name="timezone" label="Fuso horário" error={errors.timezone} help="Os horários acima são os do local do evento, neste fuso." className="sm:col-span-2">
          {(a) => (
            <Select {...a} {...reg(form, "timezone")}>
              {BR_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace("America/", "").replace("_", " ")}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <fieldset>
        <legend className="text-sm font-medium">Modalidade</legend>
        <div className="mt-2 flex flex-wrap gap-3 text-sm">
          {(
            [
              ["VENUE", "Presencial", "Em um endereço físico"],
              ["ONLINE", "Online", "Transmissão pela internet"],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex min-w-40 flex-1 cursor-pointer items-start gap-2 rounded-xl border border-border p-3 has-[:checked]:border-secondary has-[:checked]:bg-secondary/5">
              <input type="radio" className="mt-0.5" {...radio(form, "locationType", value)} />
              <span>
                <span className="font-semibold">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Evento híbrido? Escolha &quot;Presencial&quot; e explique a transmissão na descrição (etapa 4).</p>
      </fieldset>

      {locationType === "VENUE" ? (
        <div className="space-y-4 rounded-2xl border border-border p-4">
          {venues.length > 0 && (
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <legend className="sr-only">Local</legend>
              <label className="flex items-center gap-1.5">
                <input type="radio" {...radio(form, "venueMode", "existing")} /> Local já cadastrado
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" {...radio(form, "venueMode", "new")} /> Cadastrar novo local
              </label>
            </fieldset>
          )}
          {!useNew ? (
            <Field name="venueId" label="Local" error={errors.venueId}>
              {(a) => (
                <Select {...a} {...reg(form, "venueId")}>
                  <option value="">Selecione</option>
                  {venues.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-6">
              <Field name="newVenue.name" label="Nome do local" error={errors["newVenue.name"]} help="Ex.: Teatro Municipal, Arena Central." className="sm:col-span-6">
                {(a) => <Input {...a} {...reg(form, "newVenue.name")} />}
              </Field>
              <Field name="newVenue.postalCode" label="CEP" error={errors["newVenue.postalCode"]} className="sm:col-span-2">
                {(a) => <Input {...a} inputMode="numeric" autoComplete="postal-code" placeholder="00000-000" {...reg(form, "newVenue.postalCode")} />}
              </Field>
              <Field name="newVenue.street" label="Rua / avenida" error={errors["newVenue.street"]} className="sm:col-span-4">
                {(a) => <Input {...a} autoComplete="address-line1" {...reg(form, "newVenue.street")} />}
              </Field>
              <Field name="newVenue.number" label="Número" error={errors["newVenue.number"]} help="Sem número? Use S/N." className="sm:col-span-2">
                {(a) => <Input {...a} {...reg(form, "newVenue.number")} />}
              </Field>
              <Field name="newVenue.complement" label="Complemento (opcional)" error={errors["newVenue.complement"]} className="sm:col-span-4">
                {(a) => <Input {...a} autoComplete="address-line2" placeholder="Bloco, sala, portão de entrada…" {...reg(form, "newVenue.complement")} />}
              </Field>
              <Field name="newVenue.district" label="Bairro (opcional)" error={errors["newVenue.district"]} className="sm:col-span-2">
                {(a) => <Input {...a} {...reg(form, "newVenue.district")} />}
              </Field>
              <Field name="newVenue.cityId" label="Cidade e estado" error={errors["newVenue.cityId"]} className="sm:col-span-4">
                {(a) => (
                  <Select {...a} {...reg(form, "newVenue.cityId")}>
                    <option value="">Selecione</option>
                    {cities.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <p className="text-xs text-muted-foreground sm:col-span-6">Preencha o endereço completo: ele aparece na página do evento e no ingresso.</p>
            </div>
          )}
        </div>
      ) : (
        <Field
          name="onlineUrl"
          label="Link de acesso"
          error={errors.onlineUrl}
          help="Enviado só a quem comprou. Use um link https:// (Zoom, YouTube, Meet…). Detalhes da plataforma podem ir na descrição."
        >
          {(a) => <Input {...a} type="url" placeholder="https://" {...reg(form, "onlineUrl")} />}
        </Field>
      )}
    </div>
  );
}

// ── Etapa 3 (campos do evento; os tipos de ingresso ficam fora deste formulário) ──
export function StepTicketsSettings({ form, errors }: { form: Form; errors: Errors }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field name="capacity" label="Capacidade total" error={errors.capacity} help="Quantas pessoas cabem no evento, somando todos os ingressos.">
        {(a) => <Input {...a} type="number" min={1} inputMode="numeric" {...reg(form, "capacity")} />}
      </Field>
      <Field name="halfPriceQuotaPercent" label="Cota de meia-entrada (% da capacidade)" error={errors.halfPriceQuotaPercent} help="Ex.: 40. Configure conforme orientação jurídica para o seu evento.">
        {(a) => <Input {...a} type="number" min={0} max={100} step="1" inputMode="numeric" {...reg(form, "halfPriceQuotaPercent")} />}
      </Field>
      <DateTimeField form={form} name="salesStartLocal" label="Início das vendas" error={errors.salesStartLocal} />
      <DateTimeField form={form} name="salesEndLocal" label="Fim das vendas" error={errors.salesEndLocal} help="Até o fim do evento. Cada ingresso pode ter um período próprio (lotes)." />
    </div>
  );
}

export function TicketTips() {
  return (
    <Tip>
      Crie um tipo para cada preço: <strong>Inteira</strong>, <strong>Meia-entrada</strong>, <strong>VIP</strong>, <strong>Gratuito</strong>. Para vender por lotes, crie &quot;1º lote&quot; e &quot;2º
      lote&quot; com períodos de venda diferentes. Use <strong>Duplicar</strong> para copiar um ingresso e só ajustar o que muda.
    </Tip>
  );
}

// ── Etapa 4 ──
const DESCRIPTION_TEMPLATE = `Sobre o evento
Conte o que o público vai viver: atrações, convidados, o que torna o evento especial.

Programação
19h – Abertura dos portões
20h – Atração principal

Informações importantes
Idade mínima, documentos, o que levar, estacionamento, transporte.

Política de entrada
Apresente o ingresso (QR Code) e um documento com foto. Meia-entrada: leve o comprovante.`;

export function StepDescription({ form, errors, onError }: { form: Form; errors: Errors; onError: (msg: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const cover = useWatch({ control: form.control, name: "coverImageUrl" });
  const description = useWatch({ control: form.control, name: "description" }) ?? "";

  const upload = async (file: File) => {
    setUploading(true);
    const fd = new FormData();
    fd.set("file", file);
    try {
      const res = await uploadCoverAction(fd);
      if (res.ok) form.setValue("coverImageUrl", res.data.url, { shouldDirty: true });
      else onError(res.error);
    } catch {
      onError("Não foi possível enviar a imagem. Verifique sua conexão e tente de novo.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid gap-6">
      <div>
        <p className="text-sm font-medium" id="ew-cover-label">
          Imagem de capa (recomendada)
        </p>
        <div className="mt-1.5 flex flex-col gap-4 sm:flex-row sm:items-center">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cover} alt="Capa do evento" className="aspect-video w-full max-w-60 rounded-xl object-cover" />
          ) : (
            <div className="grid aspect-video w-full max-w-60 place-items-center rounded-xl bg-muted text-xs text-muted-foreground">Sem capa</div>
          )}
          <div className="space-y-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-semibold focus-within:ring-2 focus-within:ring-ring hover:bg-muted">
              <ImagePlus className="size-4" aria-hidden /> {uploading ? "Enviando…" : cover ? "Trocar imagem" : "Enviar imagem"}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                aria-describedby="ew-cover-help"
                disabled={uploading}
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              />
            </label>
            {cover && (
              <Button type="button" variant="ghost" size="sm" onClick={() => form.setValue("coverImageUrl", "", { shouldDirty: true })}>
                Remover capa
              </Button>
            )}
            <p id="ew-cover-help" className="text-xs text-muted-foreground">
              JPG, PNG ou WebP até 5 MB. Use 1600 × 900 px (proporção 16:9), boa iluminação e pouco texto na imagem — ela é cortada em telas pequenas.
            </p>
          </div>
        </div>
      </div>

      <Field
        name="description"
        label="Descrição completa"
        error={errors.description}
        help={`Mínimo de 20 caracteres (${description.trim().length} até agora). Inclua programação, informações importantes e a política de entrada.`}
      >
        {(a) => <Textarea {...a} className="min-h-56" {...reg(form, "description")} />}
      </Field>
      <div className="-mt-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const cur = form.getValues("description").trim();
            form.setValue("description", cur ? `${cur}\n\n${DESCRIPTION_TEMPLATE}` : DESCRIPTION_TEMPLATE, { shouldDirty: true });
          }}
        >
          Inserir modelo de descrição
        </Button>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field name="ageRestriction" label="Classificação indicativa" error={errors.ageRestriction}>
          {(a) => (
            <Select {...a} {...reg(form, "ageRestriction")}>
              {[0, 10, 12, 14, 16, 18].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "Livre" : `${n} anos`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field name="accessibilityInfo" label="Acessibilidade (opcional)" error={errors.accessibilityInfo} className="sm:col-span-2">
          {(a) => <Textarea {...a} placeholder="Rampas, banheiros adaptados, Libras, espaço para cadeirantes…" {...reg(form, "accessibilityInfo")} />}
        </Field>
      </div>
      <Tip>Boas descrições são curtas nos parágrafos, usam títulos (Programação, Informações importantes) e respondem às dúvidas antes que o público precise perguntar.</Tip>
    </div>
  );
}

// ── Etapa 5 ──
export function StepSettings({ form, errors }: { form: Form; errors: Errors }) {
  return (
    <div className="grid gap-6">
      <section aria-labelledby="ew-refund-title" className="grid gap-5 sm:grid-cols-2">
        <h3 id="ew-refund-title" className="font-display text-base font-bold sm:col-span-2">
          Cancelamento e reembolso
        </h3>
        <Field
          name="refundPolicy"
          label="Política de reembolso"
          error={errors.refundPolicy}
          help="Texto exibido ao comprador antes de pagar. Escreva com clareza e conforme orientação jurídica."
          className="sm:col-span-2"
        >
          {(a) => <Textarea {...a} {...reg(form, "refundPolicy")} />}
        </Field>
        <Field name="refundWindowDays" label="Dias após a compra" error={errors.refundWindowDays} help="Até quantos dias depois da compra o reembolso pode ser pedido (0 a 365).">
          {(a) => <Input {...a} type="number" min={0} max={365} step="1" inputMode="numeric" {...reg(form, "refundWindowDays")} />}
        </Field>
        <Field name="refundMinHoursBeforeEvent" label="Horas antes do evento" error={errors.refundMinHoursBeforeEvent} help="Prazo final antes do início (0 a 720). Padrão: 7 dias e 48 horas.">
          {(a) => <Input {...a} type="number" min={0} max={720} step="1" inputMode="numeric" {...reg(form, "refundMinHoursBeforeEvent")} />}
        </Field>
      </section>
      <section aria-labelledby="ew-more-title" className="space-y-2 rounded-2xl border border-border p-4 text-sm">
        <h3 id="ew-more-title" className="font-display text-base font-bold">
          Outras configurações
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <strong className="text-foreground">Dados dos compradores:</strong> marque &quot;Exigir nome por ingresso&quot; em cada tipo de ingresso (etapa 3).
          </li>
          <li>
            <strong className="text-foreground">Ingresso oculto:</strong> marque &quot;Ocultar da venda&quot; no tipo de ingresso para vendas restritas.
          </li>
          <li>
            <strong className="text-foreground">Check-in:</strong> convide a equipe de portaria em{" "}
            <Link href="/organizador/configuracoes" className="font-semibold text-secondary underline">
              Configurações › Equipe
            </Link>
            .
          </li>
          <li>
            <strong className="text-foreground">Cupons e links de divulgação:</strong> ficam na página de gestão do evento, depois de concluir o cadastro.
          </li>
        </ul>
      </section>
    </div>
  );
}

export function ErrorSummary({ errors }: { errors: Errors }) {
  const n = Object.keys(errors).length;
  if (!n) return null;
  return (
    <div role="alert" className={cn("rounded-xl border border-destructive/30 bg-destructive-soft px-4 py-3 text-sm text-destructive")}>
      {n === 1 ? "Corrija para continuar:" : `Corrija os ${n} itens abaixo para continuar:`}
      <ul className="mt-1 list-disc pl-5">
        {Object.entries(errors).map(([k, msg]) => (
          <li key={k}>
            {k === "_server" ? (
              msg
            ) : (
              <a href={`#${fieldId(k)}`} className="underline">
                {msg}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
