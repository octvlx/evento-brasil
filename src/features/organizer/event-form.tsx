"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, FieldError, Input, Label, Select, Textarea } from "@/components/ui/primitives";
import { eventInputSchema, type EventInput } from "@/features/schemas";
import { BR_TIMEZONES } from "@/lib/br";
import { saveEventAction, uploadCoverAction } from "./actions";
import { CHANGE_REASON_MIN, CHANGE_REASON_REQUIRED, REFUND_WINDOW_DAYS_AFTER_CHANGE } from "./event-change-rules";

/** Evento publicado com pedido pago: estado atual do que torna uma edição relevante (R8). */
export interface RelevantChangeGuard {
  startsAtLocal: string;
  timezone: string;
  locationType: "VENUE" | "ONLINE";
  venueId: string | null;
}

interface Props {
  eventId: string | null;
  defaults: Partial<EventInput>;
  categories: { id: string; name: string }[];
  cities: { id: string; label: string }[];
  venues: { id: string; label: string }[];
  locked?: boolean;
  relevantGuard?: RelevantChangeGuard | null;
}

export function EventForm({ eventId, defaults, categories, cities, venues, locked, relevantGuard }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [venueMode, setVenueMode] = useState<"existing" | "new">(defaults.venueId || !venues.length ? (defaults.venueId ? "existing" : "new") : "existing");
  const form = useForm<EventInput>({
    resolver: zodResolver(eventInputSchema),
    defaultValues: { locationType: "VENUE", timezone: "America/Sao_Paulo", ageRestriction: 0, refundWindowDays: 7, refundMinHoursBeforeEvent: 48, ...defaults },
  });
  const { errors } = form.formState;
  const locationType = useWatch({ control: form.control, name: "locationType" });
  const cover = useWatch({ control: form.control, name: "coverImageUrl" });
  const [startsAtLocal, timezone, venueId] = useWatch({ control: form.control, name: ["startsAtLocal", "timezone", "venueId"] });
  const [reasonRequested, setReasonRequested] = useState(false);
  // Prévia no navegador; quem decide é o servidor (que também compara cidade do local).
  const relevant =
    !!relevantGuard &&
    (startsAtLocal !== relevantGuard.startsAtLocal ||
      timezone !== relevantGuard.timezone ||
      locationType !== relevantGuard.locationType ||
      (locationType === "VENUE" && (venueMode === "new" || (venueId || null) !== relevantGuard.venueId)));
  const showReason = relevant || reasonRequested;

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      setError(null);
      const payload: EventInput = {
        ...values,
        venueId: values.locationType === "VENUE" && venueMode === "existing" ? values.venueId : undefined,
        newVenue: values.locationType === "VENUE" && venueMode === "new" ? values.newVenue : undefined,
      };
      if (showReason && (values.changeReason?.trim().length ?? 0) < CHANGE_REASON_MIN) {
        form.setError("changeReason", { message: `Descreva o motivo com pelo menos ${CHANGE_REASON_MIN} caracteres.` });
        form.setFocus("changeReason");
        return;
      }
      const res = await saveEventAction(eventId, { ...payload, changeReason: showReason ? values.changeReason : undefined });
      if (!res.ok) {
        if (res.error === CHANGE_REASON_REQUIRED) {
          setReasonRequested(true);
          form.setError("changeReason", { message: res.error });
          return;
        }
        return setError(res.error);
      }
      setSaved(true);
      setReasonRequested(false);
      form.setValue("changeReason", "");
      if (!eventId) router.push(`/organizador/eventos/${res.data.id}/editar`);
      else router.refresh();
    }),
  );

  const upload = async (file: File) => {
    setUploading(true);
    const fd = new FormData();
    fd.set("file", file);
    const res = await uploadCoverAction(fd);
    setUploading(false);
    if (res.ok) form.setValue("coverImageUrl", res.data.url, { shouldDirty: true });
    else setError(res.error);
  };

  const field = (name: keyof EventInput) => ({ "aria-invalid": !!errors[name] });

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <fieldset disabled={locked} className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="title">Título</Label>
          <Input id="title" className="mt-1.5" {...field("title")} {...form.register("title")} />
          <FieldError message={errors.title?.message} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="summary">Resumo (aparece nos cards e no compartilhamento)</Label>
          <Input id="summary" className="mt-1.5" maxLength={240} {...form.register("summary")} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="description">Descrição</Label>
          <Textarea id="description" className="mt-1.5 min-h-40" {...field("description")} {...form.register("description")} />
          <FieldError message={errors.description?.message} />
        </div>
        <div>
          <Label htmlFor="categoryId">Categoria</Label>
          <Select id="categoryId" className="mt-1.5" {...field("categoryId")} {...form.register("categoryId")}>
            <option value="">Selecione</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <FieldError message={errors.categoryId?.message} />
        </div>
        <div>
          <Label htmlFor="ageRestriction">Classificação etária</Label>
          <Select id="ageRestriction" className="mt-1.5" {...form.register("ageRestriction")}>
            {[0, 10, 12, 14, 16, 18].map((a) => (
              <option key={a} value={a}>
                {a === 0 ? "Livre" : `${a} anos`}
              </option>
            ))}
          </Select>
        </div>

        <div className="sm:col-span-2">
          <Label>Imagem de capa</Label>
          <div className="mt-1.5 flex items-center gap-4">
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={cover} alt="Capa atual" className="h-20 w-32 rounded-xl object-cover" />
            ) : (
              <div className="grid h-20 w-32 place-items-center rounded-xl bg-muted text-xs text-muted-foreground">Sem capa</div>
            )}
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-muted">
              <ImagePlus className="size-4" aria-hidden /> {uploading ? "Enviando…" : "Enviar imagem"}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            </label>
            <span className="text-xs text-muted-foreground">JPG, PNG ou WebP até 5 MB. Proporção 16:9 recomendada.</span>
          </div>
        </div>

        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-medium">Local</legend>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" value="VENUE" {...form.register("locationType")} /> Presencial
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" value="ONLINE" {...form.register("locationType")} /> Online
            </label>
          </div>
        </fieldset>

        {locationType === "VENUE" ? (
          <div className="space-y-4 rounded-2xl border border-border p-4 sm:col-span-2">
            {venues.length > 0 && (
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={venueMode === "existing"} onChange={() => setVenueMode("existing")} /> Local cadastrado
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="radio" checked={venueMode === "new"} onChange={() => setVenueMode("new")} /> Novo local
                </label>
              </div>
            )}
            {venueMode === "existing" && venues.length > 0 ? (
              <div>
                <Select aria-label="Local" {...form.register("venueId")}>
                  <option value="">Selecione</option>
                  {venues.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </Select>
                <FieldError message={errors.venueId?.message} />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label htmlFor="vname">Nome do local</Label>
                  <Input id="vname" className="mt-1.5" {...form.register("newVenue.name")} />
                  <FieldError message={errors.newVenue?.name?.message} />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="vaddr">Endereço (rua e número)</Label>
                  <Input id="vaddr" className="mt-1.5" autoComplete="street-address" {...form.register("newVenue.addressLine")} />
                  <FieldError message={errors.newVenue?.addressLine?.message} />
                </div>
                <div>
                  <Label htmlFor="vdist">Bairro</Label>
                  <Input id="vdist" className="mt-1.5" {...form.register("newVenue.district")} />
                </div>
                <div>
                  <Label htmlFor="vcep">CEP</Label>
                  <Input id="vcep" className="mt-1.5" inputMode="numeric" placeholder="00000-000" {...form.register("newVenue.postalCode")} />
                  <FieldError message={errors.newVenue?.postalCode?.message} />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="vcity">Cidade</Label>
                  <Select id="vcity" className="mt-1.5" {...form.register("newVenue.cityId")}>
                    <option value="">Selecione</option>
                    {cities.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                  <FieldError message={errors.newVenue?.cityId?.message} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="sm:col-span-2">
            <Label htmlFor="onlineUrl">Link da transmissão (enviado só aos compradores)</Label>
            <Input id="onlineUrl" className="mt-1.5" placeholder="https://" {...form.register("onlineUrl")} />
            <FieldError message={errors.onlineUrl?.message} />
          </div>
        )}

        <div>
          <Label htmlFor="timezone">Fuso horário do evento</Label>
          <Select id="timezone" className="mt-1.5" {...form.register("timezone")}>
            {BR_TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace("America/", "").replace("_", " ")}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="capacity">Capacidade total</Label>
          <Input id="capacity" type="number" min={1} className="mt-1.5" {...field("capacity")} {...form.register("capacity")} />
          <FieldError message={errors.capacity?.message} />
        </div>
        {(
          [
            ["startsAtLocal", "Início"],
            ["endsAtLocal", "Término"],
            ["salesStartLocal", "Início das vendas"],
            ["salesEndLocal", "Fim das vendas"],
          ] as const
        ).map(([name, label]) => (
          <div key={name}>
            <Label htmlFor={name}>{label} (horário local)</Label>
            <Input id={name} type="datetime-local" className="mt-1.5" {...field(name)} {...form.register(name)} />
            <FieldError message={errors[name]?.message} />
          </div>
        ))}
        <div>
          <Label htmlFor="halfPriceQuotaPercent">Cota de meia-entrada (% da capacidade)</Label>
          <Input id="halfPriceQuotaPercent" type="number" min={0} max={100} step="1" className="mt-1.5" placeholder="Ex.: 40" {...form.register("halfPriceQuotaPercent", { setValueAs: (v) => (v === "" || v === null ? undefined : Number(v)) })} />
          <p className="mt-1 text-xs text-muted-foreground">Configure conforme orientação jurídica para o seu evento.</p>
        </div>
        <div>
          <Label htmlFor="maxTicketsPerAccount">Limite de ingressos por conta (opcional)</Label>
          <Input
            id="maxTicketsPerAccount"
            type="number"
            min={1}
            max={1000}
            step="1"
            inputMode="numeric"
            className="mt-1.5"
            placeholder="Sem limite"
            {...field("maxTicketsPerAccount")}
            {...form.register("maxTicketsPerAccount", { setValueAs: (v) => (v === "" || v === null ? undefined : Number(v)) })}
          />
          <FieldError message={errors.maxTicketsPerAccount?.message} />
          <p className="mt-1 text-xs text-muted-foreground">Soma de todos os pedidos de uma mesma conta neste evento. Deixe vazio para não limitar.</p>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="refundPolicy">Política de reembolso</Label>
          <Textarea id="refundPolicy" className="mt-1.5" {...field("refundPolicy")} {...form.register("refundPolicy")} />
          <FieldError message={errors.refundPolicy?.message} />
        </div>
        <div>
          <Label htmlFor="refundWindowDays">Reembolso: dias após a compra</Label>
          <Input id="refundWindowDays" type="number" min={0} max={365} step="1" inputMode="numeric" className="mt-1.5" {...field("refundWindowDays")} {...form.register("refundWindowDays")} />
          <FieldError message={errors.refundWindowDays?.message} />
        </div>
        <div>
          <Label htmlFor="refundMinHoursBeforeEvent">Reembolso: horas antes do evento</Label>
          <Input
            id="refundMinHoursBeforeEvent"
            type="number"
            min={0}
            max={720}
            step="1"
            inputMode="numeric"
            className="mt-1.5"
            {...field("refundMinHoursBeforeEvent")}
            {...form.register("refundMinHoursBeforeEvent")}
          />
          <FieldError message={errors.refundMinHoursBeforeEvent?.message} />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          O comprador pode pedir reembolso integral até esse número de dias após a compra e até essas horas antes do início (padrão: 7 dias e 48 horas). Depois que houver ingressos vendidos, os prazos só podem
          ficar mais favoráveis ao comprador. Configure conforme orientação jurídica.
        </p>
        <div className="sm:col-span-2">
          <Label htmlFor="accessibilityInfo">Acessibilidade</Label>
          <Textarea id="accessibilityInfo" className="mt-1.5" placeholder="Rampas, banheiros adaptados, Libras, espaço para cadeirantes…" {...form.register("accessibilityInfo")} />
        </div>
      </fieldset>
      {showReason && !locked && (
        <div className="space-y-2 rounded-2xl border border-border p-4">
          <Alert variant="warning">
            Esta alteração muda data, horário, local, cidade ou formato de um evento com ingressos vendidos. Os compradores serão avisados por e-mail e poderão pedir reembolso integral por até{" "}
            {REFUND_WINDOW_DAYS_AFTER_CHANGE} dias (no máximo até o novo início).
          </Alert>
          <Label htmlFor="changeReason">Motivo da alteração (enviado aos compradores)</Label>
          <Textarea id="changeReason" maxLength={2000} aria-invalid={!!errors.changeReason} placeholder="Ex.: a banda principal remarcou a turnê e o show passou para sábado." {...form.register("changeReason")} />
          <FieldError message={errors.changeReason?.message} />
        </div>
      )}
      {error && <Alert variant="danger">{error}</Alert>}
      {saved && !error && <Alert variant="success">Evento salvo.</Alert>}
      {!locked && (
        <Button size="lg" disabled={pending}>
          {pending ? "Salvando…" : eventId ? "Salvar alterações" : "Criar rascunho"}
        </Button>
      )}
    </form>
  );
}
