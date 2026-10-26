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

interface Props {
  eventId: string | null;
  defaults: Partial<EventInput>;
  categories: { id: string; name: string }[];
  cities: { id: string; label: string }[];
  venues: { id: string; label: string }[];
  locked?: boolean;
}

export function EventForm({ eventId, defaults, categories, cities, venues, locked }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [venueMode, setVenueMode] = useState<"existing" | "new">(defaults.venueId || !venues.length ? (defaults.venueId ? "existing" : "new") : "existing");
  const form = useForm<EventInput>({
    resolver: zodResolver(eventInputSchema),
    defaultValues: { locationType: "VENUE", timezone: "America/Sao_Paulo", ageRestriction: 0, ...defaults },
  });
  const { errors } = form.formState;
  const locationType = useWatch({ control: form.control, name: "locationType" });
  const cover = useWatch({ control: form.control, name: "coverImageUrl" });

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      setError(null);
      const payload: EventInput = {
        ...values,
        venueId: values.locationType === "VENUE" && venueMode === "existing" ? values.venueId : undefined,
        newVenue: values.locationType === "VENUE" && venueMode === "new" ? values.newVenue : undefined,
      };
      const res = await saveEventAction(eventId, payload);
      if (!res.ok) return setError(res.error);
      setSaved(true);
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
        <div className="sm:col-span-2">
          <Label htmlFor="refundPolicy">Política de reembolso</Label>
          <Textarea id="refundPolicy" className="mt-1.5" {...field("refundPolicy")} {...form.register("refundPolicy")} />
          <FieldError message={errors.refundPolicy?.message} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="accessibilityInfo">Acessibilidade</Label>
          <Textarea id="accessibilityInfo" className="mt-1.5" placeholder="Rampas, banheiros adaptados, Libras, espaço para cadeirantes…" {...form.register("accessibilityInfo")} />
        </div>
      </fieldset>
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
