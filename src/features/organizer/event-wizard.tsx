"use client";

// Assistente de criação de evento: estado do formulário, navegação entre etapas,
// autosave e revisão. Os campos ficam em `event-wizard-steps.tsx`; validação e
// etapas em `wizard-steps.ts`; regras e persistência no servidor
// (`server/services/event-wizard.ts`).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { AlertTriangle, Check, CheckCircle2, CloudOff, Eye, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Card } from "@/components/ui/primitives";
import { EventCover } from "@/components/site/event-cover";
import { formatBRL } from "@/lib/money";
import { formatEventDateTime, zonedLocalToUtc } from "@/lib/datetime";
import { TICKET_KIND } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { recordWizardVisitAction, saveEventWizardStepAction, startEventDraftAction, submitEventAction } from "./actions";
import { ErrorSummary, fieldId, StepBasics, StepDateLocation, StepDescription, StepSettings, StepTicketsSettings, TicketTips, type Errors } from "./event-wizard-steps";
import { TicketTypesManager, type ManagedTicketType, type TicketEstimate } from "./ticket-types-manager";
import { DATA_STEPS, firstIncompleteStep, isDataStep, STEP_FIELDS, stepPayload, validateStep, WIZARD_STEPS, type DataStep, type WizardStep, type WizardValues } from "./wizard-steps";

export type WizardEstimate = TicketEstimate;

interface Props {
  eventId: string | null;
  step: WizardStep;
  completed: DataStep[];
  initial: WizardValues;
  categories: { id: string; name: string }[];
  cities: { id: string; label: string }[];
  venues: { id: string; label: string }[];
  ticketTypes: ManagedTicketType[];
  estimates: Record<string, WizardEstimate>;
  organizationName: string;
  canPublish: boolean;
  orgApproved: boolean;
  autoPublish: boolean;
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: Date } | { kind: "error"; message: string } | { kind: "invalid" } | { kind: "local" };

// Cópia local (neste navegador) do que foi digitado: protege contra falha de
// rede e fechamento da aba antes do autosave. A fonte da verdade é o servidor.
interface Backup {
  values: WizardValues;
  at: number;
  /** Etapas com alterações ainda não enviadas quando a cópia foi gravada. */
  dirtySteps: DataStep[];
  draftKey?: string;
}
const backupKey = (eventId: string | null) => `eb:event-wizard:${eventId ?? "novo"}`;
function readBackup(eventId: string | null): Backup | null {
  try {
    const raw = window.localStorage.getItem(backupKey(eventId));
    return raw ? (JSON.parse(raw) as Backup) : null;
  } catch {
    return null;
  }
}
function writeBackup(eventId: string | null, b: Backup) {
  try {
    window.localStorage.setItem(backupKey(eventId), JSON.stringify(b));
  } catch {}
}
function removeBackup(eventId: string | null) {
  try {
    window.localStorage.removeItem(backupKey(eventId));
  } catch {}
}

const AUTOSAVE_MS = 1200;
const noopSubscribe = () => () => {};
/** true só no navegador depois da hidratação (antes disso os botões ficam desativados). */
const useHydrated = () => useSyncExternalStore(noopSubscribe, () => true, () => false);
const wizardUrl = (id: string, step: WizardStep) => `/organizador/eventos/novo?evento=${id}&etapa=${step}`;
const savedJson = (v: WizardValues) => Object.fromEntries(DATA_STEPS.map((s) => [s, JSON.stringify(stepPayload(s, v))])) as Record<DataStep, string>;

export function EventWizard(props: Props) {
  const { eventId, step, initial } = props;
  const router = useRouter();
  const [navigating, startNav] = useTransition();
  const form = useForm<WizardValues>({ defaultValues: initial });
  const hydrated = useHydrated();
  const [errors, setErrors] = useState<Errors>({});
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [localCompleted, setLocalCompleted] = useState<DataStep[]>([]);
  const [restore, setRestore] = useState<Backup | null>(null);
  const [draftKey] = useState(() => crypto.randomUUID());
  const eventIdRef = useRef(eventId);
  const draftKeyRef = useRef<string | null>(null);
  const lastSaved = useRef(savedJson(initial));
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);

  const completed = DATA_STEPS.filter((s) => props.completed.includes(s) || localCompleted.includes(s));
  const reachable = (n: WizardStep) => n === firstIncompleteStep(completed) || (isDataStep(n) && completed.includes(n));
  const percent = Math.round((completed.length / DATA_STEPS.length) * 100);
  const meta = WIZARD_STEPS[step - 1];

  // Abriu outro rascunho (ex.: "Continuar cadastro"): recarrega os valores do servidor.
  useEffect(() => {
    if (eventId && eventId !== eventIdRef.current) {
      eventIdRef.current = eventId;
      form.reset(initial);
      lastSaved.current = savedJson(initial);
    }
  }, [eventId, initial, form]);

  // Alterações deste navegador que não chegaram ao servidor: oferecer restaurar.
  useEffect(() => {
    const b = readBackup(eventIdRef.current);
    if (!b) return;
    if (!eventIdRef.current && b.draftKey) draftKeyRef.current = b.draftKey;
    const pending = (b.dirtySteps ?? []).filter((s) => JSON.stringify(stepPayload(s, b.values)) !== lastSaved.current[s]);
    if (pending.length) setRestore({ ...b, dirtySteps: pending });
    else if (eventIdRef.current) removeBackup(eventIdRef.current);
  }, []);

  const dirtySteps = useCallback(() => {
    const v = form.getValues();
    return DATA_STEPS.filter((s) => JSON.stringify(stepPayload(s, v)) !== lastSaved.current[s]);
  }, [form]);
  const dirty = useCallback(() => dirtySteps().length > 0, [dirtySteps]);

  const backup = useCallback(() => {
    writeBackup(eventIdRef.current, {
      values: form.getValues(),
      at: Date.now(),
      dirtySteps: dirtySteps(),
      draftKey: eventIdRef.current ? undefined : (draftKeyRef.current ?? draftKey),
    });
  }, [form, dirtySteps, draftKey]);

  /** Recusa de validação do servidor vira erro do formulário; o resto é falha ao salvar. */
  const rejected = useCallback((res: { error: string; code?: string }) => {
    if (res.code === "VALIDATION") {
      setErrors({ _server: res.error });
      setState({ kind: "invalid" });
    } else setState({ kind: "error", message: res.error });
  }, []);

  /**
   * Salva uma etapa no servidor. As chamadas entram numa fila: autosave e
   * "Continuar" nunca correm em paralelo (nem criam dois rascunhos).
   */
  const persist = useCallback(
    (s: DataStep, complete: boolean): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        const values = form.getValues();
        const payload = stepPayload(s, values);
        const json = JSON.stringify(payload);
        if (!complete && eventIdRef.current && lastSaved.current[s] === json) return true;
        setState({ kind: "saving" });
        try {
          let id = eventIdRef.current;
          if (!id) {
            if (s !== 1) return false;
            const res = await startEventDraftAction({
              ...payload,
              draftKey: draftKeyRef.current ?? draftKey,
            });
            if (!res.ok) {
              rejected(res);
              return false;
            }
            id = res.data.id;
            eventIdRef.current = id;
            removeBackup(null);
            if (!complete) startNav(() => router.replace(wizardUrl(id!, 1), { scroll: false }));
          }
          if (complete || lastSaved.current[s] !== json) {
            const res = await saveEventWizardStepAction(id, s, payload, complete);
            if (!res.ok) {
              rejected(res);
              return false;
            }
            setLocalCompleted(res.data.completed);
          }
          lastSaved.current[s] = json;
          setState({ kind: "saved", at: new Date() });
          backup();
          return true;
        } catch {
          setState({
            kind: "error",
            message: "Sem conexão com o servidor. Suas alterações continuam guardadas neste navegador.",
          });
          backup();
          return false;
        }
      };
      const p = queue.current.then(run, run);
      queue.current = p;
      return p;
    },
    [form, draftKey, router, backup, rejected],
  );

  // Autosave com debounce: só envia quando a etapa está válida.
  useEffect(() => {
    if (!isDataStep(step)) return;
    const unsubscribe = form.subscribe({
      formState: { values: true },
      callback: ({ name }) => {
        if (name)
          setErrors((e) =>
            Object.keys(e).some((k) => k === name || k.startsWith(`${name}.`) || name.startsWith(`${k}.`))
              ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== name && !k.startsWith(`${name}.`) && !name.startsWith(`${k}.`)))
              : e,
          );
        backup();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          if (Object.keys(validateStep(step, form.getValues())).length) return setState({ kind: eventIdRef.current ? "invalid" : "local" });
          void persist(step, false);
        }, AUTOSAVE_MS);
      },
    });
    return () => {
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [step, form, persist, backup]);

  // Ao trocar de etapa: foco no título da etapa e registro da última etapa acessada.
  useEffect(() => {
    if (shownStep.current !== step) {
      shownStep.current = step;
      headingRef.current?.focus();
    }
    if (eventIdRef.current) void recordWizardVisitAction(eventIdRef.current, step).catch(() => undefined);
  }, [step]);

  // Avisa antes de fechar a aba com alterações ainda não salvas.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty()) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const go = (n: WizardStep) => {
    if (!eventIdRef.current) return;
    setErrors({});
    startNav(() => router.push(wizardUrl(eventIdRef.current!, n), { scroll: false }));
  };

  /** Sai da etapa sem validar: salva em segundo plano se estiver válida; nada se perde da memória. */
  const leaveTo = (n: WizardStep) => {
    if (timer.current) clearTimeout(timer.current);
    if (isDataStep(step) && !Object.keys(validateStep(step, form.getValues())).length) void persist(step, false);
    go(n);
  };

  const showErrors = (errs: Errors) => {
    setErrors(errs);
    const first = Object.keys(errs)[0];
    if (first) requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-field="${first}"]`) ?? document.getElementById(fieldId(first)))?.focus());
  };

  const next = async () => {
    if (!isDataStep(step)) return;
    if (timer.current) clearTimeout(timer.current);
    const errs = validateStep(step, form.getValues());
    if (step === 3 && !props.ticketTypes.length) errs.tickets = "Cadastre ao menos um tipo de ingresso para continuar.";
    if (Object.keys(errs).length) return showErrors(errs);
    setBusy(true);
    const ok = await persist(step, true);
    setBusy(false);
    if (ok) go((step + 1) as WizardStep);
  };

  const saveDraft = async () => {
    if (!isDataStep(step)) return;
    if (timer.current) clearTimeout(timer.current);
    const errs = validateStep(step, form.getValues());
    if (Object.keys(errs).length) return showErrors(errs);
    await persist(step, false);
  };

  const doRestore = async () => {
    if (!restore) return;
    setRestore(null);
    // Só os campos das etapas que tinham alterações pendentes; o resto vem do servidor.
    for (const s of restore.dirtySteps) for (const f of STEP_FIELDS[s]) {
      // Backups anteriores podem não conter configurações adicionadas depois.
      if (f in restore.values) form.setValue(f as keyof WizardValues, restore.values[f as keyof WizardValues], { shouldDirty: true });
    }
    // Reenvia as etapas já liberadas que estiverem válidas.
    for (const s of restore.dirtySteps) {
      if (s !== step && !completed.includes(s)) continue;
      if (!Object.keys(validateStep(s, form.getValues())).length) await persist(s, false);
    }
  };

  const formStep = isDataStep(step);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Stepper step={step} completed={completed} percent={percent} reachable={reachable} onGo={(n) => (n === step ? undefined : leaveTo(n))} disabled={!eventId} />

      {restore && (
        <Alert variant="warning" className="flex flex-wrap items-center justify-between gap-3">
          <span>Encontramos alterações feitas neste navegador em {new Date(restore.at).toLocaleString("pt-BR")} que não foram salvas.</span>
          <span className="flex gap-2">
            <Button type="button" size="sm" onClick={doRestore}>
              Restaurar
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                removeBackup(eventIdRef.current);
                setRestore(null);
              }}
            >
              Descartar
            </Button>
          </span>
        </Alert>
      )}

      <Card className="p-5 sm:p-7">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Etapa {step} de {WIZARD_STEPS.length}
            </p>
            <h2 ref={headingRef} tabIndex={-1} className="font-display text-xl font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {meta.title}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{meta.hint}</p>
          </div>
          {formStep && <SaveIndicator state={state} onRetry={() => isDataStep(step) && void saveDraft()} />}
        </div>

        {formStep ? (
          <form
            id="event-wizard-form"
            method="post"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void next();
            }}
            className="space-y-6"
            aria-describedby={Object.keys(errors).length ? "ew-error-summary" : undefined}
          >
            <div id="ew-error-summary">
              <ErrorSummary errors={errors} />
            </div>
            {step === 1 && <StepBasics form={form} errors={errors} categories={props.categories} organizationName={props.organizationName} />}
            {step === 2 && <StepDateLocation form={form} errors={errors} cities={props.cities} venues={props.venues} />}
            {step === 3 && <StepTicketsSettings form={form} errors={errors} />}
            {step === 4 && <StepDescription form={form} errors={errors} onError={(m) => setState({ kind: "error", message: m })} />}
            {step === 5 && <StepSettings form={form} errors={errors} />}
          </form>
        ) : (
          <Review {...props} values={form.getValues()} completed={completed} onEdit={(n) => leaveTo(n)} />
        )}

        {step === 3 && eventId && (
          <section id={fieldId("tickets")} data-field="tickets" tabIndex={-1} aria-labelledby="ew-tickets-title" className="mt-8 space-y-4 border-t border-border pt-6 outline-none">
            <h3 id="ew-tickets-title" className="font-display text-base font-bold">
              Tipos de ingresso
            </h3>
            <TicketTips />
            <TicketTypesManager eventId={eventId} items={props.ticketTypes} estimates={props.estimates} allowDuplicate />
          </section>
        )}

        {formStep && (
          <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col-reverse gap-3 sm:flex-row">
              {step > 1 ? (
                <Button type="button" variant="outline" onClick={() => leaveTo((step - 1) as WizardStep)} disabled={!hydrated || navigating}>
                  Voltar
                </Button>
              ) : (
                <Link href="/organizador/eventos" className="inline-flex h-11 items-center justify-center rounded-xl px-5 text-sm font-semibold hover:bg-muted">
                  Sair
                </Link>
              )}
              <Button type="button" variant="ghost" onClick={() => void saveDraft()} disabled={!hydrated || busy || state.kind === "saving"}>
                Salvar rascunho
              </Button>
            </div>
            <Button type="submit" form="event-wizard-form" size="lg" disabled={!hydrated || busy || navigating}>
              {busy || navigating ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {busy ? "Salvando…" : step === 5 ? "Continuar para a revisão" : "Continuar"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function Stepper({
  step,
  completed,
  percent,
  reachable,
  onGo,
  disabled,
}: {
  step: WizardStep;
  completed: DataStep[];
  percent: number;
  reachable: (n: WizardStep) => boolean;
  onGo: (n: WizardStep) => void;
  disabled: boolean;
}) {
  return (
    <nav aria-label="Etapas do cadastro do evento" className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Progresso do cadastro" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full rounded-full bg-secondary transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
        <span className="text-xs font-semibold tabular-nums text-muted-foreground">{percent}% concluído</span>
      </div>
      <ol className="grid grid-cols-6 gap-1">
        {WIZARD_STEPS.map(({ n, short, title }) => {
          const done = isDataStep(n) && completed.includes(n);
          const current = n === step;
          const can = !disabled && !current && reachable(n as WizardStep);
          const status = current ? "etapa atual" : done ? "concluída" : "pendente";
          const content = (
            <>
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-full border-2 text-xs font-bold transition-colors",
                  current ? "border-secondary bg-secondary text-secondary-foreground" : done ? "border-success bg-success-soft text-success" : "border-border bg-card text-muted-foreground",
                )}
                aria-hidden
              >
                {done && !current ? <Check className="size-4" /> : n}
              </span>
              <span className={cn("hidden text-center text-xs leading-tight md:block", current ? "font-semibold" : "text-muted-foreground")}>{short}</span>
              <span className="sr-only">
                {n}. {title} ({status})
              </span>
            </>
          );
          return (
            <li key={n} className="flex justify-center">
              {can ? (
                <button
                  type="button"
                  onClick={() => onGo(n as WizardStep)}
                  className="flex flex-col items-center gap-1 rounded-xl p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {content}
                </button>
              ) : (
                <span className={cn("flex flex-col items-center gap-1 p-1", !current && "opacity-60")} aria-current={current ? "step" : undefined}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-center text-xs text-muted-foreground md:hidden">
        Etapa {step} de 6: <strong className="text-foreground">{WIZARD_STEPS[step - 1].title}</strong>
      </p>
    </nav>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-9 items-center gap-2 text-xs font-medium">
      {state.kind === "saving" && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Salvando…
        </span>
      )}
      {state.kind === "saved" && (
        <span className="flex items-center gap-1.5 text-success">
          <CheckCircle2 className="size-4" aria-hidden /> Salvo às{" "}
          {state.at.toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      )}
      {state.kind === "invalid" && (
        <span className="flex items-center gap-1.5 text-warning">
          <AlertTriangle className="size-4" aria-hidden /> Alterações pendentes — complete os campos para salvar
        </span>
      )}
      {state.kind === "local" && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <CloudOff className="size-4" aria-hidden /> Guardado neste navegador. Preencha nome e categoria para criar o rascunho.
        </span>
      )}
      {state.kind === "error" && (
        <span className="flex flex-wrap items-center gap-1.5 text-destructive">
          <AlertTriangle className="size-4" aria-hidden /> Erro ao salvar: {state.message}
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Tentar novamente
          </Button>
        </span>
      )}
    </div>
  );
}

// ── Etapa 6: revisão e publicação ──
function Review(
  props: Props & {
    values: WizardValues;
    completed: DataStep[];
    onEdit: (n: WizardStep) => void;
  },
) {
  const { values: v, ticketTypes, estimates } = props;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState(false);

  const category = props.categories.find((c) => c.id === v.categoryId)?.name ?? "—";
  const fmt = (local: string) => {
    try {
      return formatEventDateTime(zonedLocalToUtc(local, v.timezone), v.timezone);
    } catch {
      return "—";
    }
  };
  const place =
    v.locationType === "ONLINE"
      ? `Online · ${v.onlineUrl}`
      : v.venueMode === "new"
        ? `${v.newVenue.name} · ${v.newVenue.street}, ${v.newVenue.number}${v.newVenue.complement ? ` – ${v.newVenue.complement}` : ""}${v.newVenue.district ? ` · ${v.newVenue.district}` : ""} · ${props.cities.find((c) => c.id === v.newVenue.cityId)?.label ?? ""}`
        : (props.venues.find((x) => x.id === v.venueId)?.label ?? "—");
  const totalTickets = ticketTypes.reduce((s, t) => s + t.quantityTotal, 0);

  const issues: {
    tone: "danger" | "warning";
    text: string;
    step?: WizardStep;
  }[] = [];
  for (const s of DATA_STEPS)
    if (!props.completed.includes(s))
      issues.push({
        tone: "danger",
        text: `Etapa ${s} (${WIZARD_STEPS[s - 1].title}) não foi concluída.`,
        step: s,
      });
  if (!ticketTypes.length)
    issues.push({
      tone: "danger",
      text: "Cadastre ao menos um tipo de ingresso.",
      step: 3,
    });
  if (totalTickets > Number(v.capacity))
    issues.push({
      tone: "warning",
      text: `Os ingressos somam ${totalTickets}, acima da capacidade de ${v.capacity}. A venda para quando a capacidade esgota.`,
      step: 3,
    });
  if (!v.coverImageUrl)
    issues.push({
      tone: "warning",
      text: "Sem imagem de capa: a página usará uma imagem padrão.",
      step: 4,
    });
  if (!props.orgApproved)
    issues.push({
      tone: "danger",
      text: "Sua organização ainda não foi aprovada pela plataforma. Você pode deixar o evento pronto e publicar depois da aprovação.",
    });
  if (!props.canPublish)
    issues.push({
      tone: "danger",
      text: "Seu papel na organização não permite publicar. Peça a um administrador da organização.",
    });
  const blocked = issues.some((i) => i.tone === "danger");

  const publish = () =>
    start(async () => {
      try {
        const r = await submitEventAction(props.eventId!);
        if (!r.ok) return setResult({ ok: false, text: r.error });
        removeBackup(props.eventId);
        setResult({
          ok: true,
          text: r.data.status === "PUBLISHED" ? "Evento publicado!" : "Enviado para a moderação da plataforma. Avisaremos quando for aprovado.",
        });
        router.push(`/organizador/eventos/${props.eventId}/editar`);
      } catch {
        setResult({
          ok: false,
          text: "Sem conexão com o servidor. Tente novamente.",
        });
      }
    });

  return (
    <div className="space-y-4">
      {issues.length > 0 && (
        <ul className="space-y-2" aria-label="Pendências">
          {issues.map((i) => (
            <li key={i.text}>
              <Alert variant={i.tone} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <strong>{i.tone === "danger" ? "Obrigatório: " : "Atenção: "}</strong>
                  {i.text}
                </span>
                {i.step && (
                  <Button type="button" size="sm" variant="outline" onClick={() => props.onEdit(i.step!)}>
                    Ir para a etapa {i.step}
                  </Button>
                )}
              </Alert>
            </li>
          ))}
        </ul>
      )}

      <Section title="Informações gerais" n={1} onEdit={props.onEdit}>
        <Row k="Nome">{v.title}</Row>
        <Row k="Categoria">{category}</Row>
        <Row k="Resumo">{v.summary}</Row>
        <Row k="Organização">{props.organizationName}</Row>
      </Section>
      <Section title="Datas e localização" n={2} onEdit={props.onEdit}>
        <Row k="Início">{fmt(v.startsAtLocal)}</Row>
        <Row k="Término">{fmt(v.endsAtLocal)}</Row>
        <Row k="Fuso">{v.timezone.replace("America/", "").replace("_", " ")}</Row>
        <Row k="Local">{place}</Row>
      </Section>
      <Section title="Ingressos e preços" n={3} onEdit={props.onEdit}>
        <Row k="Capacidade">{v.capacity}</Row>
        <Row k="Cota de meia">{v.halfPriceQuotaPercent ? `${v.halfPriceQuotaPercent}%` : "Não configurada"}</Row>
        <Row k="Limite por conta">{v.maxTicketsPerAccount ? `${v.maxTicketsPerAccount} ingresso(s)` : "Sem limite"}</Row>
        <Row k="Vendas">
          {fmt(v.salesStartLocal)} até {fmt(v.salesEndLocal)}
        </Row>
        <Row k="Ingressos">
          {ticketTypes.length ? (
            <ul className="space-y-0.5">
              {ticketTypes.map((t) => (
                <li key={t.id}>
                  {t.name} · {TICKET_KIND[t.kind]} · {t.priceCents ? formatBRL(t.priceCents) : "Gratuito"} · {t.quantityTotal} un.
                  {estimates[t.id] && <span className="text-muted-foreground"> · você recebe ≈ {formatBRL(estimates[t.id].organizerGetsCents)}</span>}
                  {t.isHidden && " · oculto"}
                </li>
              ))}
            </ul>
          ) : null}
        </Row>
      </Section>
      <Section title="Imagens e descrição" n={4} onEdit={props.onEdit}>
        <Row k="Capa">{v.coverImageUrl ? "Enviada" : "Sem capa"}</Row>
        <Row k="Descrição">{v.description ? `${v.description.trim().slice(0, 160)}${v.description.trim().length > 160 ? "…" : ""}` : ""}</Row>
        <Row k="Classificação">{v.ageRestriction === "0" ? "Livre" : `${v.ageRestriction} anos`}</Row>
        <Row k="Acessibilidade">{v.accessibilityInfo}</Row>
      </Section>
      <Section title="Configurações" n={5} onEdit={props.onEdit}>
        <Row k="Reembolso">
          Até {v.refundWindowDays} dias após a compra e até {v.refundMinHoursBeforeEvent} horas antes do início.
        </Row>
        <Row k="Transferência">Até {v.transferDeadlineHours} horas antes do início; no máximo {v.transferMaxTransfers} transferência(s) por ingresso.</Row>
        <Row k="Devolução ao titular anterior">{v.transferAllowReturn ? "Permitida com pedido, aceite e consumo do limite" : "Não permitida"}</Row>
        <Row k="Política">{v.refundPolicy}</Row>
      </Section>

      {preview && <Preview {...props} values={v} category={category} place={place} fmt={fmt} />}

      {result && <Alert variant={result.ok ? "success" : "danger"}>{result.text}</Alert>}

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col-reverse gap-3 sm:flex-row">
          <Button type="button" variant="outline" onClick={() => props.onEdit(5)}>
            Voltar
          </Button>
          <Link href="/organizador/eventos" className="inline-flex h-11 items-center justify-center rounded-xl px-5 text-sm font-semibold hover:bg-muted">
            Salvar rascunho e sair
          </Link>
          <Button type="button" variant="ghost" onClick={() => setPreview((p) => !p)} aria-expanded={preview}>
            <Eye aria-hidden /> {preview ? "Fechar pré-visualização" : "Pré-visualizar"}
          </Button>
        </div>
        <Button type="button" variant="accent" size="lg" disabled={blocked || pending} onClick={publish}>
          {pending && <Loader2 className="animate-spin" aria-hidden />}
          {props.autoPublish ? "Publicar evento" : "Enviar para publicação"}
        </Button>
      </div>
      {!props.autoPublish && !blocked && <p className="text-right text-xs text-muted-foreground">A plataforma revisa o evento antes de ele aparecer para o público.</p>}
    </div>
  );
}

function Section({ title, n, onEdit, children }: { title: string; n: WizardStep; onEdit: (n: WizardStep) => void; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border p-4" aria-label={title}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-display text-sm font-bold">{title}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(n)} aria-label={`Editar ${title.toLowerCase()}`}>
          <Pencil aria-hidden /> Editar
        </Button>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">{children}</dl>
    </section>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="break-words">{children || "—"}</dd>
    </>
  );
}

/** Prévia aproximada da página pública (a página real é a de /eventos, após a publicação). */
function Preview({
  values: v,
  ticketTypes,
  estimates,
  category,
  place,
  fmt,
}: Props & {
  values: WizardValues;
  category: string;
  place: string;
  fmt: (l: string) => string;
}) {
  const visible = ticketTypes.filter((t) => !t.isHidden);
  return (
    <section aria-label="Pré-visualização da página do evento" className="overflow-hidden rounded-2xl border-2 border-dashed border-secondary/50">
      <p className="bg-secondary/10 px-4 py-2 text-xs font-semibold text-secondary">Pré-visualização — ainda não está visível para o público</p>
      <div className="aspect-[21/9] w-full bg-muted">
        <EventCover src={v.coverImageUrl || null} alt={`Capa de ${v.title}`} />
      </div>
      <div className="space-y-3 p-5">
        <p className="text-xs font-semibold uppercase text-muted-foreground">{category}</p>
        <h3 className="font-display text-2xl font-bold">{v.title}</h3>
        {v.summary && <p className="text-muted-foreground">{v.summary}</p>}
        <p className="text-sm">
          {fmt(v.startsAtLocal)} · {place}
        </p>
        <div className="whitespace-pre-line text-sm">{v.description}</div>
        {visible.length > 0 && (
          <ul className="divide-y divide-border rounded-xl border border-border text-sm">
            {visible.map((t) => (
              <li key={t.id} className="flex justify-between gap-3 p-3">
                <span>{t.name}</span>
                <span className="font-semibold">
                  {t.priceCents ? formatBRL(estimates[t.id]?.buyerPaysCents ?? t.priceCents) : "Gratuito"}
                  {estimates[t.id]?.bearer === "BUYER" && <span className="block text-right text-xs font-normal text-muted-foreground">com taxa de serviço</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
