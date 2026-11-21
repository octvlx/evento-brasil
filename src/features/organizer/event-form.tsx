"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, FieldError, Input, Label, Select, Textarea } from "@/components/ui/primitives";
import { eventInputSchema, type EventInput } from "@/features/schemas";
import { BR_TIMEZONES } from "@/lib/br";
import { lookupVenuePostalCodeAction, saveEventAction, uploadCoverAction } from "./actions";
import { MunicipalityCombobox } from "./municipality-combobox";
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
  venues: { id: string; label: string }[];
  locked?: boolean;
  relevantGuard?: RelevantChangeGuard | null;
}

export function EventForm({ eventId, defaults, categories, venues, locked, relevantGuard }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [venueMode, setVenueMode] = useState<"existing" | "new">(defaults.venueId || !venues.length ? (defaults.venueId ? "existing" : "new") : "existing");
  const form = useForm<EventInput>({
    resolver: zodResolver(eventInputSchema),
    defaultValues: { locationType: "VENUE", timezone: "America/Sao_Paulo", ageRestriction: 0, refundWindowDays: 7, refundMinHoursBeforeEvent: 48, transferDeadlineHours: 24, transferMaxTransfers: 1, transferAllowReturn: false, ...defaults },
  });
  const { errors } = form.formState;
  const locationType = useWatch({ control: form.control, name: "locationType" });
  const cover = useWatch({ control: form.control, name: "coverImageUrl" });
  const mapImage = useWatch({ control: form.control, name: "mapImageUrl" });
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

  const upload = async (file: File, target: "coverImageUrl" | "mapImageUrl" = "coverImageUrl") => {
    setUploading(true);
    const fd = new FormData();
    fd.set("file", file);
    const res = await uploadCoverAction(fd);
    setUploading(false);
    if (res.ok) form.setValue(target, res.data.url, { shouldDirty: true });
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
                <EditPostalCodeAndCity
                  form={form}
                  postalCodeError={errors.newVenue?.postalCode?.message}
                  cityError={errors.newVenue?.cityIbgeCode?.message ?? errors.newVenue?.cityId?.message}
                  ufError={errors.newVenue?.cityUf?.message}
                />
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
          <Label htmlFor="halfPriceQuotaPercent">Limite de meia-entrada (mínimo legal 40%)</Label>
          <Input id="halfPriceQuotaPercent" type="number" min={40} max={100} step="1" className="mt-1.5" placeholder="Ex.: 40" aria-describedby="halfPriceQuotaHelp" {...form.register("halfPriceQuotaPercent", { setValueAs: (v) => (v === "" || v === null ? undefined : Number(v)) })} />
          <p id="halfPriceQuotaHelp" className="mt-1 text-xs text-muted-foreground">A reserva de 40% dos ingressos para meia-entrada, até 48 h antes do início (72 h se o local tiver mais de 10.000 lugares), é automática e não pode ser desligada. Este campo só define até quanto você oferece de meia; deixe vazio para não limitar além dos 40%.</p>
          <FieldError message={errors.halfPriceQuotaPercent?.message} />
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
        <div>
          <Label htmlFor="transferDeadlineHours">Transferência: horas antes do início</Label>
          <Input id="transferDeadlineHours" type="number" min={0} max={8760} step="1" className="mt-1.5" {...field("transferDeadlineHours")} {...form.register("transferDeadlineHours")} />
          <FieldError message={errors.transferDeadlineHours?.message} />
          <p className="mt-1 text-xs text-muted-foreground">Padrão: 24 horas. Use 0 para permitir até o início.</p>
        </div>
        <div>
          <Label htmlFor="transferMaxTransfers">Máximo de transferências por ingresso</Label>
          <Input id="transferMaxTransfers" type="number" min={1} max={10} step="1" className="mt-1.5" {...field("transferMaxTransfers")} {...form.register("transferMaxTransfers")} />
          <FieldError message={errors.transferMaxTransfers?.message} />
        </div>
        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" {...form.register("transferAllowReturn")} /> Permitir nova transferência para um titular anterior
          </label>
          <FieldError message={errors.transferAllowReturn?.message} />
          <p className="mt-1 text-xs text-muted-foreground">A devolução exige pedido do titular atual e aceite do destinatário, e consome uma transferência do limite. Permita ao menos 2 para habilitá-la. Não é um desfazer unilateral.</p>
          <p className="mt-1 text-xs text-muted-foreground">Com ingressos vendidos ou reservados, reduza a antecedência, aumente o limite ou habilite a devolução; os direitos já oferecidos não podem ser reduzidos.</p>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="accessibilityInfo">Acessibilidade</Label>
          <Textarea id="accessibilityInfo" className="mt-1.5" placeholder="Rampas, banheiros adaptados, Libras, espaço para cadeirantes…" {...form.register("accessibilityInfo")} />
        </div>
        <div className="sm:col-span-2">
          <Label>Mapa do evento (opcional)</Label>
          <div className="mt-1.5 flex flex-wrap items-center gap-4">
            {mapImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mapImage} alt="Mapa atual" className="h-20 w-32 rounded-xl object-contain bg-muted" />
            ) : (
              <div className="grid h-20 w-32 place-items-center rounded-xl bg-muted text-xs text-muted-foreground">Sem mapa</div>
            )}
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-muted">
              <ImagePlus className="size-4" aria-hidden /> {uploading ? "Enviando…" : "Enviar mapa"}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], "mapImageUrl")} />
            </label>
            {mapImage && (
              <Button type="button" variant="ghost" size="sm" onClick={() => form.setValue("mapImageUrl", "", { shouldDirty: true })}>
                Remover mapa
              </Button>
            )}
            <span className="text-xs text-muted-foreground">Planta com setores, palco e acessos. JPG, PNG ou WebP até 5 MB.</span>
          </div>
          <FieldError message={errors.mapImageUrl?.message} />
        </div>
        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" {...form.register("isUnlisted")} /> Evento privado (fora da busca)
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Não aparece na busca, na página da cidade, no seu perfil público nem nos buscadores. Quem tiver o link (ou um link rastreado) abre a página e compra normalmente.
          </p>
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

/**
 * CEP com busca no ViaCEP (pelo servidor, a mesma do assistente) e a cidade. Ao sair do
 * campo só preenche o que estiver vazio; "Buscar" sobrescreve rua, bairro e cidade. O
 * número fica sempre com o organizador (o endereço aqui é "rua e número" numa linha).
 */
function EditPostalCodeAndCity({
  form,
  postalCodeError,
  ufError,
  cityError,
}: {
  form: UseFormReturn<EventInput>;
  postalCodeError?: string;
  ufError?: string;
  cityError?: string;
}) {
  const [uf, ibgeCode] = useWatch({ control: form.control, name: ["newVenue.cityUf", "newVenue.cityIbgeCode"] });
  const [name, setName] = useState("");
  const [state, setState] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const last = useRef<string | null>(null);
  const field = form.register("newVenue.postalCode");

  async function lookup(force: boolean) {
    const digits = (form.getValues("newVenue.postalCode") ?? "").replace(/\D/g, "");
    if (!/^\d{8}$/.test(digits)) {
      if (force) setState({ tone: "error", text: "Informe um CEP de 8 dígitos." });
      return;
    }
    if (!force && last.current === digits) return;
    const mine = ++revision.current;
    last.current = digits;
    setBusy(true);
    setState({ tone: "info", text: "Buscando endereço…" });
    const res = await lookupVenuePostalCodeAction(digits);
    if (mine !== revision.current) return;
    setBusy(false);
    if (!res.ok) return setState({ tone: "error", text: `${res.error.replace(/\s*Preencha o endereço manualmente\.?$/, "")} Você pode preencher o endereço manualmente.` });
    const a = res.data;
    const opts = { shouldDirty: true };
    form.setValue("newVenue.postalCode", `${digits.slice(0, 5)}-${digits.slice(5)}`, opts);
    if (a.street && (force || !form.getValues("newVenue.addressLine")?.trim())) form.setValue("newVenue.addressLine", `${a.street}, `, opts);
    if (a.district && (force || !form.getValues("newVenue.district")?.trim())) form.setValue("newVenue.district", a.district, opts);
    if (a.ibgeCode && (force || !form.getValues("newVenue.cityIbgeCode"))) {
      form.setValue("newVenue.cityUf", a.state, opts);
      form.setValue("newVenue.cityIbgeCode", a.ibgeCode, opts);
      setName(a.city);
    }
    const tips = [!a.street && "informe a rua (CEP geral da cidade)", !a.ibgeCode && `escolha a cidade na lista (${a.city} – ${a.state} não foi encontrada na base do IBGE)`, "complete o número no endereço"].filter(Boolean);
    setState({ tone: "info", text: `Endereço localizado: ${[a.street, a.district, `${a.city} — ${a.state}`].filter(Boolean).join(", ")}. Agora ${tips.join(" e ")}.` });
  }

  return (
    <>
      <div>
        <Label htmlFor="vcep">CEP</Label>
        <div className="mt-1.5 flex gap-2">
          <Input
            {...field}
            id="vcep"
            inputMode="numeric"
            autoComplete="postal-code"
            placeholder="00000-000"
            maxLength={9}
            aria-describedby="vcep-status"
            onChange={(e) => {
              revision.current++;
              setBusy(false);
              setState(null);
              return field.onChange(e);
            }}
            onBlur={(e) => {
              void lookup(false);
              return field.onBlur(e);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void lookup(true);
              }
            }}
          />
          <Button type="button" variant="outline" disabled={busy} onClick={() => void lookup(true)}>
            Buscar
          </Button>
        </div>
        <p id="vcep-status" role="status" className={state?.tone === "error" ? "mt-1 text-xs text-destructive" : "mt-1 text-xs text-muted-foreground"}>
          {state?.text}
        </p>
        <FieldError message={postalCodeError} />
      </div>
      <EditMunicipality form={form} uf={uf} ibgeCode={ibgeCode} name={name} setName={setName} cityError={cityError} ufError={ufError} />
    </>
  );
}

function EditMunicipality({
  form,
  uf,
  ibgeCode,
  name,
  setName,
  ufError,
  cityError,
}: {
  form: UseFormReturn<EventInput>;
  uf: unknown;
  ibgeCode: unknown;
  name: string;
  setName: (v: string) => void;
  ufError?: string;
  cityError?: string;
}) {
  return (
    <MunicipalityCombobox
      className="sm:col-span-2"
      idPrefix="vcity"
      value={{ uf: typeof uf === "string" ? uf : "", ibgeCode: typeof ibgeCode === "string" ? ibgeCode : "", name }}
      ufError={ufError}
      cityError={cityError}
      onChange={(v) => {
        setName(v.name);
        form.setValue("newVenue.cityUf", v.uf, { shouldDirty: true });
        form.setValue("newVenue.cityIbgeCode", v.ibgeCode, { shouldDirty: true });
      }}
    />
  );
}
