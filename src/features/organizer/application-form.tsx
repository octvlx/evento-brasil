"use client";

// Cadastro de organizador em passos (Perfil → Marca → Dados legais → Contato →
// Revisão). Cada "Continuar" valida só o passo atual; o envio final manda o mesmo
// `OrganizerApplicationInput` de antes às actions, que revalidam tudo no servidor.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Building2, Check, CircleCheck, Loader2, Lock, Pencil, Send, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, FieldError, Input, Label, Skeleton, Textarea } from "@/components/ui/primitives";
import type { OrganizerReviewArea } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { createOrganizationAction, resubmitApplicationAction } from "./actions";
import { MunicipalityCombobox, municipalityLabel } from "./municipality-combobox";
import {
  APPLICATION_DATA_STEPS,
  APPLICATION_REVIEW_STEP,
  APPLICATION_STEPS,
  DESCRIPTION_MAX,
  blankApplication,
  documentLabel,
  documentStatus,
  draftKey,
  firstIncompleteStep,
  isReachable,
  legalNameLabel,
  maskDocument,
  maskPhone,
  maskedDocumentTail,
  nextStepAfter,
  normalizeWebsite,
  readDraft,
  removeDraft,
  stepForRejection,
  stepForReviewArea,
  stripAt,
  toApplicationInput,
  toDraft,
  validStepsOf,
  validateApplicationStep,
  writeDraft,
  type ApplicationDataStep,
  type ApplicationField,
  type ApplicationStep,
  type ApplicationValues,
  type LegalType,
} from "./application-steps";

type Errors = Partial<Record<ApplicationField, string>>;

const noopSubscribe = () => () => {};
/** true só no navegador depois da hidratação (antes disso os botões ficam desativados). */
const useHydrated = () => useSyncExternalStore(noopSubscribe, () => true, () => false);

const fieldId: Record<Exclude<ApplicationField, "legalType" | "cityName" | "cityId">, string> = {
  name: "org-name",
  cityUf: "org-city-uf",
  cityIbgeCode: "org-city-city",
  description: "org-description",
  legalName: "org-legal-name",
  document: "org-document",
  contactEmail: "org-email",
  contactPhone: "org-phone",
  websiteUrl: "org-site",
  instagramHandle: "org-instagram",
};
const idOf = (f: ApplicationField, v: ApplicationValues) => (f === "legalType" ? `org-type-${v.legalType}` : f === "cityName" || f === "cityId" ? fieldId.cityIbgeCode : fieldId[f]);

const PROFILES: { value: LegalType; title: string; hint: string; icon: typeof Building2 }[] = [
  { value: "COMPANY", title: "Empresa (CNPJ)", hint: "Produtora, casa de shows, bar, agência ou associação.", icon: Building2 },
  { value: "INDIVIDUAL", title: "Pessoa física (CPF)", hint: "Artista, coletivo, DJ ou produtor independente.", icon: UserRound },
];

/** Campos de texto: 16 px no celular (o iOS não dá zoom), 14 px a partir do sm. */
const inputText = "text-base sm:text-sm";

interface Props {
  userId: string;
  defaults?: Partial<ApplicationValues>;
  /** Presente = reenvio de cadastro recusado; ausente = nova organização. */
  resubmitOrganizationId?: string;
  /** Motivo da recusa anterior (fica visível em todos os passos). */
  rejectionReason?: string | null;
  /** Parte do cadastro que o admin pediu para corrigir. */
  rejectionArea?: OrganizerReviewArea | null;
}

/**
 * O assistente só monta no navegador: o estado inicial lê o rascunho do
 * localStorage sem divergir do HTML do servidor. Antes disso, um esqueleto.
 */
export function ApplicationForm(props: Props) {
  const hydrated = useHydrated();
  if (!hydrated) return <FormSkeleton />;
  return <ApplicationWizard {...props} />;
}

function FormSkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-5" aria-busy="true" aria-label="Carregando o cadastro">
      <div className="grid grid-cols-5 gap-2">
        {APPLICATION_STEPS.map(({ n }) => (
          <Skeleton key={n} className="h-1.5 rounded-full sm:h-9" />
        ))}
      </div>
      <div className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-card sm:p-8">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-7 w-3/4" />
        <div className="grid gap-3 pt-3 sm:grid-cols-2">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="ml-auto h-12 w-full sm:w-40" />
      </div>
    </div>
  );
}

interface Initial {
  values: ApplicationValues;
  completed: ApplicationDataStep[];
  step: ApplicationStep;
  restored: boolean;
}

function initialState({ userId, defaults, resubmitOrganizationId, rejectionReason, rejectionArea }: Props): Initial {
  const resubmit = !!resubmitOrganizationId;
  const base = blankApplication(defaults);
  // Rascunho deste navegador (sem CPF/CNPJ nem nome legal).
  const draft = readDraft(draftKey(userId, resubmitOrganizationId));
  if (draft) {
    const values = { ...base, ...draft.values };
    const completed = validStepsOf(values).filter((s) => resubmit || s < draft.step);
    const step = isReachable(draft.step, completed) ? draft.step : firstIncompleteStep(completed);
    return { values, completed, step, restored: true };
  }
  if (!resubmit) return { values: base, completed: [], step: 1, restored: false };
  // Reenvio: os passos já válidos contam como concluídos e o fluxo abre no passo
  // ligado ao motivo (ou no primeiro pendente — os dados legais são digitados de novo).
  const completed = validStepsOf(base);
  // A área escolhida pelo admin manda; sem ela, uma pista no texto do motivo.
  const hinted = stepForReviewArea(rejectionArea) ?? stepForRejection(rejectionReason);
  return { values: base, completed, step: hinted && isReachable(hinted, completed) ? hinted : firstIncompleteStep(completed), restored: false };
}

function ApplicationWizard(props: Props) {
  const { userId, defaults, resubmitOrganizationId, rejectionReason } = props;
  const areaStep = stepForReviewArea(props.rejectionArea);
  const resubmit = !!resubmitOrganizationId;
  const storageKey = draftKey(userId, resubmitOrganizationId);
  const [initial] = useState(() => initialState(props));

  const [values, setValues] = useState<ApplicationValues>(initial.values);
  const [completed, setCompleted] = useState<ApplicationDataStep[]>(initial.completed);
  const [step, setStep] = useState<ApplicationStep>(initial.step);
  const [errors, setErrors] = useState<Errors>({});
  const [returnToReview, setReturnToReview] = useState(false);
  const [notice, setNotice] = useState<{ text: string; restored?: boolean } | null>(
    initial.restored ? { text: "Recuperamos o que você preencheu neste navegador.", restored: true } : null,
  );
  const [accepted, setAccepted] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, start] = useTransition();
  const [focusTarget, setFocusTarget] = useState<{ id: string; n: number } | null>(null);
  const dirty = useRef(initial.restored);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const router = useRouter();

  const legal = values.legalType;
  const docLabel = documentLabel(legal);
  const meta = APPLICATION_STEPS[step - 1];

  useEffect(() => {
    if (submitted || !dirty.current) return;
    writeDraft(storageKey, toDraft(step, values));
  }, [submitted, step, values, storageKey]);

  useEffect(() => {
    if (!focusTarget) return;
    const el = focusTarget.id === "heading" ? headingRef.current : document.getElementById(focusTarget.id);
    el?.focus();
    if (el && focusTarget.id !== "heading") el.scrollIntoView?.({ block: "center" });
  }, [focusTarget]);

  const focus = (id: string) => setFocusTarget((f) => ({ id, n: (f?.n ?? 0) + 1 }));

  function set<K extends ApplicationField>(field: K, value: ApplicationValues[K]) {
    dirty.current = true;
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  }

  function changeType(t: LegalType) {
    if (t === values.legalType) return;
    dirty.current = true;
    const hadDocument = !!values.document;
    setValues((v) => ({ ...v, legalType: t, document: "" }));
    // O documento depende do tipo: o passo de dados legais volta a ficar pendente.
    setCompleted((c) => c.filter((s) => s !== 3));
    setNotice(hadDocument ? { text: `Como você mudou para ${documentLabel(t)}, digite o documento de novo no passo Dados legais.` } : null);
  }

  function goTo(n: ApplicationStep, opts?: { fromReview?: boolean }) {
    setErrors({});
    setSubmitError(null);
    if (opts?.fromReview) setReturnToReview(true);
    if (n === APPLICATION_REVIEW_STEP) setReturnToReview(false);
    setStep(n);
    focus("heading");
  }

  function showErrors(found: Errors) {
    setErrors(found);
    const first = Object.keys(found)[0] as ApplicationField | undefined;
    if (first) focus(idOf(first, values));
  }

  function onContinue() {
    if (step === APPLICATION_REVIEW_STEP) return submit();
    const found = validateApplicationStep(step, values);
    if (Object.keys(found).length) return showErrors(found);
    const done = completed.includes(step) ? completed : [...completed, step].sort();
    setCompleted(done);
    goTo(nextStepAfter(step, done, returnToReview));
  }

  function submit() {
    // Rede de segurança: algum passo pode ter ficado inválido (ex.: trocou o tipo).
    for (const s of APPLICATION_DATA_STEPS) {
      const found = validateApplicationStep(s, values);
      if (Object.keys(found).length) {
        setCompleted((c) => c.filter((x) => x !== s));
        setStep(s);
        setReturnToReview(true);
        return showErrors(found);
      }
    }
    if (!accepted) {
      setTermsError("Para enviar, aceite os termos para organizadores.");
      return focus("org-terms");
    }
    setSubmitError(null);
    start(async () => {
      try {
        const input = toApplicationInput(values);
        const res = resubmitOrganizationId ? await resubmitApplicationAction(resubmitOrganizationId, input) : await createOrganizationAction(input);
        if (res.ok) {
          // A tela "Enviado" é uma rota própria, renderizada pelo status real da
          // organização: a action troca a organização ativa e a página recarrega.
          dirty.current = false;
          setSubmitted(true);
          removeDraft(storageKey);
          router.replace("/organizador/cadastro/enviado");
        } else setSubmitError(res.error);
      } catch {
        setSubmitError("Não conseguimos enviar agora. Verifique sua conexão e tente de novo: seus dados continuam aqui.");
      }
    });
  }

  function startOver() {
    removeDraft(storageKey);
    dirty.current = false;
    setValues(blankApplication(defaults));
    setCompleted(resubmit ? validStepsOf(blankApplication(defaults)) : []);
    setNotice(null);
    setErrors({});
    goTo(1);
  }

  const errorCount = Object.values(errors).filter(Boolean).length;
  const describe = (f: ApplicationField, ...extra: (string | false | undefined)[]) =>
    [errors[f] && `${idOf(f, values)}-error`, ...extra].filter(Boolean).join(" ") || undefined;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      {rejectionReason !== undefined && (
        <Alert variant="danger">
          <strong className="font-semibold">Seu cadastro anterior foi recusado.</strong> Motivo: {rejectionReason || "sem motivo informado"}.
          {areaStep ? ` Ajuste pedido em ${APPLICATION_STEPS[areaStep - 1].short}.` : ""} Corrija os dados e envie novamente.
        </Alert>
      )}
      <Stepper step={step} completed={completed} onGo={(n) => goTo(n)} disabled={pending} />
      {notice && (
        <Alert variant={notice.restored ? "info" : "warning"} className="flex flex-wrap items-center justify-between gap-2">
          <span>{notice.text}</span>
          <span className="flex gap-1">
            {notice.restored && (
              <Button type="button" size="sm" variant="ghost" onClick={startOver}>
                Começar do zero
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => setNotice(null)}>
              Fechar
            </Button>
          </span>
        </Alert>
      )}

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onContinue();
        }}
        className="rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-card sm:p-8"
      >
        <div key={step} className="motion-safe:animate-step-in">
          <p className="text-xs font-semibold uppercase tracking-wide text-secondary">
            Passo {step} de {APPLICATION_STEPS.length} · {meta.short}
          </p>
          <h2 ref={headingRef} tabIndex={-1} className="mt-1 font-display text-xl font-bold focus:outline-none sm:text-2xl">
            {meta.title}
          </h2>
          {errorCount > 0 && (
            <p role="alert" className="mt-3 rounded-xl bg-destructive-soft px-3 py-2 text-sm font-medium text-destructive">
              {errorCount === 1 ? "Corrija 1 campo para continuar." : `Corrija ${errorCount} campos para continuar.`}
            </p>
          )}

          <div className="mt-6 space-y-5">
            {step === 1 && (
              <fieldset>
                <legend className="sr-only">Tipo de cadastro</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {PROFILES.map(({ value, title, hint, icon: Icon }) => {
                    const checked = legal === value;
                    return (
                      <label
                        key={value}
                        htmlFor={`org-type-${value}`}
                        className={cn(
                          "relative flex cursor-pointer gap-3 rounded-2xl border-2 p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring sm:flex-col sm:p-5",
                          checked ? "border-secondary bg-secondary/5" : "border-border hover:border-foreground/30",
                        )}
                      >
                        <input
                          id={`org-type-${value}`}
                          type="radio"
                          name="legalType"
                          value={value}
                          checked={checked}
                          onChange={() => changeType(value)}
                          className="sr-only"
                        />
                        <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", checked ? "bg-secondary text-secondary-foreground" : "bg-muted text-foreground")} aria-hidden>
                          <Icon className="size-5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block font-semibold">{title}</span>
                          <span className="mt-0.5 block text-sm text-muted-foreground">{hint}</span>
                        </span>
                        {checked && (
                          <CircleCheck className="absolute right-3 top-3 size-5 text-secondary motion-safe:animate-step-in" aria-hidden />
                        )}
                      </label>
                    );
                  })}
                </div>
                <p className="mt-3 text-sm text-muted-foreground">O restante do cadastro se adapta à sua escolha. Você pode criar outra organização depois, se precisar.</p>
              </fieldset>
            )}

            {step === 2 && (
              <>
                <ProfilePreview name={values.name} city={values.cityIbgeCode && values.cityName ? municipalityLabel(values.cityName, values.cityUf) : ""} />
                <div>
                  <Label htmlFor={fieldId.name}>Nome público</Label>
                  <Input
                    id={fieldId.name}
                    className={cn("mt-1.5", inputText)}
                    value={values.name}
                    maxLength={120}
                    autoComplete="organization"
                    onChange={(e) => set("name", e.target.value)}
                    aria-invalid={!!errors.name}
                    aria-describedby={describe("name", "org-name-help")}
                  />
                  <FieldError id="org-name-error" message={errors.name} />
                  <p id="org-name-help" className="mt-1 text-xs text-muted-foreground">
                    É o nome que aparece nos seus eventos e ingressos.
                  </p>
                </div>
                <fieldset>
                  <legend className="mb-1.5 text-sm font-medium">
                    Cidade-sede <span className="font-normal text-muted-foreground">(opcional)</span>
                  </legend>
                  <MunicipalityCombobox
                    idPrefix="org-city"
                    help="Escolha a cidade na lista. Aparece no perfil público da organização."
                    value={{ uf: values.cityUf, ibgeCode: values.cityIbgeCode, name: values.cityName }}
                    ufError={errors.cityUf}
                    cityError={errors.cityIbgeCode}
                    onChange={(v) => {
                      dirty.current = true;
                      // Escolheu (ou limpou) pelo autocomplete: a cidade antiga deixa de valer.
                      setValues((cur) => ({ ...cur, cityUf: v.uf, cityIbgeCode: v.ibgeCode, cityName: v.name, cityId: "" }));
                      setErrors((e) => ({ ...e, cityUf: undefined, cityIbgeCode: undefined }));
                    }}
                  />
                </fieldset>
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor={fieldId.description}>
                      Conte em poucas linhas o que você faz <span className="font-normal text-muted-foreground">(opcional)</span>
                    </Label>
                  </div>
                  <Textarea
                    id={fieldId.description}
                    className={cn("mt-1.5", inputText)}
                    value={values.description}
                    maxLength={DESCRIPTION_MAX}
                    onChange={(e) => set("description", e.target.value)}
                    aria-invalid={!!errors.description}
                    aria-describedby={describe("description", "org-description-help")}
                  />
                  <FieldError id="org-description-error" message={errors.description} />
                  <p id="org-description-help" className="mt-1 flex justify-between gap-2 text-xs text-muted-foreground">
                    <span>Duas ou três frases bastam: o tipo de evento, o público e onde você atua.</span>
                    <span className="shrink-0 tabular-nums">
                      {values.description.length}/{DESCRIPTION_MAX}
                    </span>
                  </p>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="flex gap-3 rounded-xl bg-muted p-4 text-sm">
                  <Lock className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden />
                  <p>
                    Pedimos estes dados para emitir os repasses e cumprir obrigações fiscais. Eles ficam cifrados e mostramos só os últimos dígitos.
                    {resubmit && " Por segurança, os dados legais não ficam salvos para edição: digite de novo."}
                  </p>
                </div>
                <div>
                  <Label htmlFor={fieldId.legalName}>{legalNameLabel(legal)}</Label>
                  <Input
                    id={fieldId.legalName}
                    className={cn("mt-1.5", inputText)}
                    value={values.legalName}
                    maxLength={200}
                    autoComplete={legal === "INDIVIDUAL" ? "name" : "organization"}
                    onChange={(e) => set("legalName", e.target.value)}
                    aria-invalid={!!errors.legalName}
                    aria-describedby={describe("legalName", "org-legal-name-help")}
                  />
                  <FieldError id="org-legal-name-error" message={errors.legalName} />
                  <p id="org-legal-name-help" className="mt-1 text-xs text-muted-foreground">
                    {legal === "COMPANY" ? "Como está no cartão CNPJ." : "Como está no seu documento."}
                  </p>
                </div>
                <DocumentField
                  legal={legal}
                  value={values.document}
                  error={errors.document}
                  onChange={(v) => set("document", v)}
                  label={docLabel}
                />
              </>
            )}

            {step === 4 && (
              <>
                <div>
                  <Label htmlFor={fieldId.contactEmail}>E-mail de contato</Label>
                  <Input
                    id={fieldId.contactEmail}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    className={cn("mt-1.5", inputText)}
                    value={values.contactEmail}
                    onChange={(e) => set("contactEmail", e.target.value)}
                    aria-invalid={!!errors.contactEmail}
                    aria-describedby={describe("contactEmail", "org-email-help")}
                  />
                  <FieldError id="org-email-error" message={errors.contactEmail} />
                  <p id="org-email-help" className="mt-1 text-xs text-muted-foreground">
                    Viemos com o e-mail da sua conta. Pode ser outro, como o da produtora.
                  </p>
                </div>
                <div>
                  <Label htmlFor={fieldId.contactPhone}>
                    Celular / WhatsApp <span className="font-normal text-muted-foreground">(opcional)</span>
                  </Label>
                  <Input
                    id={fieldId.contactPhone}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    placeholder="(11) 91234-5678"
                    className={cn("mt-1.5", inputText)}
                    value={values.contactPhone}
                    onChange={(e) => set("contactPhone", maskPhone(e.target.value))}
                    aria-invalid={!!errors.contactPhone}
                    aria-describedby={describe("contactPhone", "org-phone-help")}
                  />
                  <FieldError id="org-phone-error" message={errors.contactPhone} />
                  <p id="org-phone-help" className="mt-1 text-xs text-muted-foreground">
                    Usado pela equipe da plataforma se precisar falar com você sobre o cadastro.
                  </p>
                </div>
                <div>
                  <Label htmlFor={fieldId.websiteUrl}>
                    Site <span className="font-normal text-muted-foreground">(opcional)</span>
                  </Label>
                  <Input
                    id={fieldId.websiteUrl}
                    type="url"
                    inputMode="url"
                    autoComplete="url"
                    placeholder="https://"
                    className={cn("mt-1.5", inputText)}
                    value={values.websiteUrl}
                    onChange={(e) => set("websiteUrl", e.target.value)}
                    onBlur={(e) => set("websiteUrl", normalizeWebsite(e.target.value))}
                    aria-invalid={!!errors.websiteUrl}
                    aria-describedby={describe("websiteUrl")}
                  />
                  <FieldError id="org-site-error" message={errors.websiteUrl} />
                </div>
                <div>
                  <Label htmlFor={fieldId.instagramHandle}>
                    Instagram <span className="font-normal text-muted-foreground">(opcional)</span>
                  </Label>
                  <div className="relative mt-1.5">
                    <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-muted-foreground" aria-hidden>
                      @
                    </span>
                    <Input
                      id={fieldId.instagramHandle}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="seuperfil"
                      className={cn("pl-8", inputText)}
                      value={values.instagramHandle}
                      onChange={(e) => set("instagramHandle", stripAt(e.target.value))}
                      aria-invalid={!!errors.instagramHandle}
                      aria-describedby={describe("instagramHandle")}
                    />
                  </div>
                  <FieldError id="org-instagram-error" message={errors.instagramHandle} />
                </div>
              </>
            )}

            {step === 5 && (
              <Review
                values={values}
                onEdit={(n) => goTo(n, { fromReview: true })}
                disabled={pending}
                accepted={accepted}
                onAccept={(v) => {
                  setAccepted(v);
                  if (v) setTermsError(null);
                }}
                termsError={termsError}
              />
            )}
          </div>
        </div>

        {submitError && (
          <Alert variant="danger" className="mt-6">
            {submitError}
          </Alert>
        )}

        <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          {step > 1 ? (
            <Button type="button" variant="ghost" onClick={() => goTo((step - 1) as ApplicationStep)} disabled={pending}>
              <ArrowLeft aria-hidden /> Voltar
            </Button>
          ) : (
            <span className="hidden sm:block" />
          )}
          <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={pending || submitted}>
            {step === APPLICATION_REVIEW_STEP ? (
              pending || submitted ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden /> Enviando…
                </>
              ) : (
                <>
                  <Send aria-hidden /> Enviar para análise
                </>
              )
            ) : (
              <>
                {returnToReview && firstIncompleteStep(completed.includes(step) ? completed : [...completed, step]) === APPLICATION_REVIEW_STEP ? "Voltar para a revisão" : "Continuar"}
                <ArrowRight aria-hidden />
              </>
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Stepper({ step, completed, onGo, disabled }: { step: ApplicationStep; completed: readonly ApplicationDataStep[]; onGo: (n: ApplicationStep) => void; disabled: boolean }) {
  return (
    <nav aria-label="Passos do cadastro">
      <ol className="grid grid-cols-5 gap-1.5 sm:gap-2">
        {APPLICATION_STEPS.map(({ n, short }) => {
          const current = n === step;
          const done = n !== APPLICATION_REVIEW_STEP && completed.includes(n as ApplicationDataStep);
          const can = !disabled && !current && done;
          const status = current ? "passo atual" : done ? "concluído" : "pendente";
          const content = (
            <>
              <span
                aria-hidden
                className={cn("block h-1.5 w-full rounded-full transition-colors sm:hidden", current ? "bg-secondary" : done ? "bg-success" : "bg-muted")}
              />
              <span className="hidden flex-col items-center gap-1 text-center sm:flex">
                <span
                  aria-hidden
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full border-2 text-xs font-bold transition-colors",
                    current ? "border-secondary bg-secondary text-secondary-foreground" : done ? "border-success bg-success-soft text-success" : "border-border bg-card text-muted-foreground",
                  )}
                >
                  {done && !current ? <Check className="size-3.5 motion-safe:animate-step-in" /> : n}
                </span>
                <span aria-hidden className={cn("text-xs leading-tight", current ? "font-semibold text-foreground" : "text-muted-foreground")}>
                  {short}
                </span>
              </span>
              <span className="sr-only">
                {n}. {short} ({status})
              </span>
            </>
          );
          return (
            <li key={n} className="min-w-0">
              {can ? (
                <button
                  type="button"
                  onClick={() => onGo(n)}
                  className="block w-full rounded-lg py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-1.5"
                >
                  {content}
                </button>
              ) : (
                <span className="block py-2 sm:px-1.5" aria-current={current ? "step" : undefined}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ProfilePreview({ name, city }: { name: string; city: string }) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <div aria-hidden className="flex items-center gap-3 rounded-2xl border border-dashed border-border bg-background p-4">
      <span className="grid size-12 shrink-0 place-items-center rounded-full bg-night font-display text-lg font-bold text-lime">{initial || "?"}</span>
      <span className="min-w-0">
        <span className={cn("block truncate font-semibold", !name.trim() && "text-muted-foreground")}>{name.trim() || "Seu nome aparece aqui"}</span>
        <span className="block truncate text-xs text-muted-foreground">{city ? `${city} · Organizador na TICKET24` : "Organizador na TICKET24"}</span>
      </span>
      <span className="ml-auto hidden shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:block">Prévia do perfil</span>
    </div>
  );
}

function DocumentField({ legal, value, error, onChange, label }: { legal: LegalType; value: string; error?: string; onChange: (v: string) => void; label: string }) {
  const status = documentStatus(value, legal);
  // O dígito verificador é conferido assim que todos os números foram digitados.
  const shown = error ?? (status === "invalid" ? `${label} inválido. Confira os números.` : undefined);
  return (
    <div>
      <Label htmlFor={fieldId.document}>{label}</Label>
      <Input
        id={fieldId.document}
        inputMode="numeric"
        autoComplete="off"
        placeholder={legal === "COMPANY" ? "00.000.000/0000-00" : "000.000.000-00"}
        className={cn("mt-1.5 tabular-nums", inputText)}
        value={value}
        onChange={(e) => onChange(maskDocument(e.target.value, legal))}
        aria-invalid={!!shown}
        aria-describedby={[shown && "org-document-error", status === "valid" && "org-document-ok", "org-document-help"].filter(Boolean).join(" ")}
      />
      <FieldError id="org-document-error" message={shown} />
      {status === "valid" && !shown && (
        <p id="org-document-ok" className="mt-1.5 flex items-center gap-1 text-xs font-medium text-success">
          <Check className="size-3.5" aria-hidden /> {label} válido
        </p>
      )}
      <p id="org-document-help" className="mt-1 text-xs text-muted-foreground">
        Só números; a pontuação entra sozinha.
      </p>
    </div>
  );
}

function Review({
  values,
  onEdit,
  disabled,
  accepted,
  onAccept,
  termsError,
}: {
  values: ApplicationValues;
  onEdit: (n: ApplicationDataStep) => void;
  disabled: boolean;
  accepted: boolean;
  onAccept: (v: boolean) => void;
  termsError: string | null;
}) {
  const legal = values.legalType;
  const none = <span className="text-muted-foreground">Não informado</span>;
  const sections: { n: ApplicationDataStep; rows: [string, ReactNode][] }[] = [
    { n: 1, rows: [["Tipo de cadastro", legal === "COMPANY" ? "Empresa (CNPJ)" : "Pessoa física (CPF)"]] },
    {
      n: 2,
      rows: [
        ["Nome público", values.name],
        ["Cidade-sede", values.cityIbgeCode && values.cityName ? municipalityLabel(values.cityName, values.cityUf) : values.cityId ? "Cidade cadastrada anteriormente" : none],
        ["Descrição", values.description ? <span key="desc" className="line-clamp-3 whitespace-pre-line">{values.description}</span> : none],
      ],
    },
    {
      n: 3,
      rows: [
        [legalNameLabel(legal), values.legalName],
        [documentLabel(legal), maskedDocumentTail(values.document, legal)],
      ],
    },
    {
      n: 4,
      rows: [
        ["E-mail de contato", <span key="email" className="break-all">{values.contactEmail}</span>],
        ["Celular / WhatsApp", values.contactPhone || none],
        ["Site", values.websiteUrl ? <span key="site" className="break-all">{values.websiteUrl}</span> : none],
        ["Instagram", values.instagramHandle ? `@${values.instagramHandle}` : none],
      ],
    },
  ];
  return (
    <>
      <div className="space-y-3">
        {sections.map(({ n, rows }) => {
          const title = APPLICATION_STEPS[n - 1].short;
          return (
            <section key={n} aria-labelledby={`review-${n}`} className="rounded-2xl border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 id={`review-${n}`} className="text-sm font-semibold">
                  {title}
                </h3>
                <Button type="button" size="sm" variant="ghost" onClick={() => onEdit(n)} disabled={disabled} aria-label={`Editar ${title}`}>
                  <Pencil aria-hidden /> Editar
                </Button>
              </div>
              <dl className="mt-2 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
                {rows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="-mt-1.5 min-w-0 font-medium sm:mt-0">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
      <div>
        <label htmlFor="org-terms" className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border p-4 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
          <input
            id="org-terms"
            type="checkbox"
            checked={accepted}
            onChange={(e) => onAccept(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-[var(--secondary)]"
            aria-invalid={!!termsError}
            aria-describedby={termsError ? "org-terms-error" : undefined}
          />
          <span className="text-sm">
            Li e aceito os{" "}
            <Link href="/termos-organizador" target="_blank" className="font-medium text-secondary underline underline-offset-2">
              termos para organizadores
            </Link>{" "}
            em nome desta organização.
          </span>
        </label>
        <FieldError id="org-terms-error" message={termsError ?? undefined} />
        <p className="mt-3 text-xs text-muted-foreground">
          A equipe da plataforma analisa o cadastro. A verificação de identidade para recebimentos é feita pelo provedor de pagamento na conexão da conta.
        </p>
      </div>
    </>
  );
}
