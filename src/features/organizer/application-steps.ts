// Cadastro de organizador em passos: metadados, validação por passo, máscaras e
// rascunho local. A validação reaproveita `organizerApplicationFields` e as regras
// de `organizerApplicationSchema`; o envio final manda o mesmo
// `OrganizerApplicationInput` às actions, e o servidor SEMPRE revalida tudo.
import {
  organizerApplicationFields as fields,
  validateApplicationCity,
  validateApplicationDocument,
  type OrganizerApplicationInput,
} from "@/features/schemas";
import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/br";
import type { OrganizerReviewArea } from "@/lib/labels";

export const APPLICATION_STEPS = [
  { n: 1, short: "Perfil", title: "Como você vai vender ingressos?" },
  { n: 2, short: "Marca", title: "Como o público vai te conhecer" },
  { n: 3, short: "Dados legais", title: "Para os repasses e as obrigações fiscais" },
  { n: 4, short: "Contato", title: "Como a equipe e o público falam com você" },
  { n: 5, short: "Revisão", title: "Confira antes de enviar" },
] as const;

export type ApplicationStep = 1 | 2 | 3 | 4 | 5;
/** Passos com dados; o 5 é só a revisão. */
export type ApplicationDataStep = 1 | 2 | 3 | 4;
export const APPLICATION_DATA_STEPS: readonly ApplicationDataStep[] = [1, 2, 3, 4];
export const APPLICATION_REVIEW_STEP = 5 as const;

export const DESCRIPTION_MAX = 2000;

export type LegalType = "COMPANY" | "INDIVIDUAL";

/** Estado do formulário no navegador (tudo texto; vazio = não informado). */
export interface ApplicationValues {
  legalType: LegalType;
  name: string;
  legalName: string;
  document: string;
  contactEmail: string;
  contactPhone: string;
  websiteUrl: string;
  /** Sem o "@" (o campo mostra o prefixo). */
  instagramHandle: string;
  description: string;
  cityUf: string;
  cityIbgeCode: string;
  cityName: string;
  /** Cidade antiga sem código IBGE (compatibilidade); some ao escolher outra. */
  cityId: string;
}

export type ApplicationField = keyof ApplicationValues;

export function blankApplication(defaults?: Partial<ApplicationValues>): ApplicationValues {
  return {
    legalType: "COMPANY",
    name: "",
    legalName: "",
    document: "",
    contactEmail: "",
    contactPhone: "",
    websiteUrl: "",
    instagramHandle: "",
    description: "",
    cityUf: "",
    cityIbgeCode: "",
    cityName: "",
    cityId: "",
    ...Object.fromEntries(Object.entries(defaults ?? {}).filter(([, v]) => v !== undefined && v !== null)),
  };
}

const STEP_SCHEMAS = {
  1: fields.pick({ legalType: true }),
  2: fields.pick({ name: true, description: true, cityUf: true, cityIbgeCode: true, cityName: true, cityId: true }).superRefine(validateApplicationCity),
  3: fields.pick({ legalType: true, legalName: true, document: true }).superRefine(validateApplicationDocument),
  4: fields.pick({ contactEmail: true, contactPhone: true, websiteUrl: true, instagramHandle: true }),
} as const;

/** Campos de cada passo, na ordem da tela (para focar o primeiro com erro). */
export const STEP_FIELDS: Record<ApplicationDataStep, readonly ApplicationField[]> = {
  1: ["legalType"],
  2: ["name", "cityUf", "cityIbgeCode", "description"],
  3: ["legalName", "document"],
  4: ["contactEmail", "contactPhone", "websiteUrl", "instagramHandle"],
};

/** Entrada das actions (mesmo contrato do formulário antigo). */
export function toApplicationInput(v: ApplicationValues): OrganizerApplicationInput {
  return {
    legalType: v.legalType,
    name: v.name,
    legalName: v.legalName,
    document: v.document,
    contactEmail: v.contactEmail,
    contactPhone: v.contactPhone || undefined,
    websiteUrl: v.websiteUrl || undefined,
    instagramHandle: v.instagramHandle || undefined,
    description: v.description || undefined,
    cityUf: (v.cityUf || undefined) as OrganizerApplicationInput["cityUf"],
    cityIbgeCode: v.cityIbgeCode || undefined,
    cityName: v.cityName || undefined,
    cityId: v.cityId || undefined,
  };
}

/** Erros do passo por campo, na ordem da tela. Vazio = passo válido. */
export function validateApplicationStep(step: ApplicationDataStep, v: ApplicationValues): Partial<Record<ApplicationField, string>> {
  const res = STEP_SCHEMAS[step].safeParse(toApplicationInput(v));
  if (res.success) return {};
  const found: Partial<Record<ApplicationField, string>> = {};
  for (const issue of res.error.issues) {
    const key = issue.path[0] as ApplicationField;
    if (!(key in found)) found[key] = issue.message;
  }
  // Documento vazio: pedir o dado em vez de dizer que é inválido.
  if (found.document && !onlyDigits(v.document)) found.document = `Informe o ${documentLabel(v.legalType)}`;
  const ordered: Partial<Record<ApplicationField, string>> = {};
  for (const f of STEP_FIELDS[step]) if (found[f]) ordered[f] = found[f];
  return ordered;
}

export function validStepsOf(v: ApplicationValues): ApplicationDataStep[] {
  return APPLICATION_DATA_STEPS.filter((s) => Object.keys(validateApplicationStep(s, v)).length === 0);
}

export function firstIncompleteStep(completed: readonly ApplicationDataStep[]): ApplicationStep {
  return APPLICATION_DATA_STEPS.find((s) => !completed.includes(s)) ?? APPLICATION_REVIEW_STEP;
}

/** Pode ir até lá: passos concluídos e o primeiro pendente (a revisão só com tudo pronto). */
export function isReachable(n: ApplicationStep, completed: readonly ApplicationDataStep[]): boolean {
  return n === firstIncompleteStep(completed) || (n !== APPLICATION_REVIEW_STEP && completed.includes(n as ApplicationDataStep));
}

/** Para onde "Continuar" leva depois de concluir `step`. */
export function nextStepAfter(step: ApplicationDataStep, completed: readonly ApplicationDataStep[], returnToReview: boolean): ApplicationStep {
  const all = firstIncompleteStep(completed) === APPLICATION_REVIEW_STEP;
  if (returnToReview && all) return APPLICATION_REVIEW_STEP;
  const next = (step + 1) as ApplicationStep;
  return isReachable(next, completed) ? next : firstIncompleteStep(completed);
}

// ── Documento e telefone ──

export const documentLabel = (t: LegalType) => (t === "COMPANY" ? "CNPJ" : "CPF");
export const legalNameLabel = (t: LegalType) => (t === "COMPANY" ? "Razão social" : "Nome completo");

/** Máscara progressiva: 000.000.000-00 ou 00.000.000/0000-00. */
export function maskDocument(raw: string, t: LegalType): string {
  const d = onlyDigits(raw).slice(0, t === "COMPANY" ? 14 : 11);
  const parts =
    t === "COMPANY"
      ? [d.slice(0, 2), d.slice(2, 5), d.slice(5, 8), d.slice(8, 12), d.slice(12, 14)]
      : [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9), d.slice(9, 11)];
  const seps = t === "COMPANY" ? [".", ".", "/", "-"] : [".", ".", "-"];
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) if (parts[i]) out += seps[i - 1] + parts[i];
  return out;
}

/** "incomplete" enquanto faltam dígitos; depois, o dígito verificador decide. */
export function documentStatus(raw: string, t: LegalType): "empty" | "incomplete" | "valid" | "invalid" {
  const d = onlyDigits(raw);
  if (!d) return "empty";
  if (d.length < (t === "COMPANY" ? 14 : 11)) return "incomplete";
  return (t === "COMPANY" ? isValidCNPJ(d) : isValidCPF(d)) ? "valid" : "invalid";
}

/** Últimos dígitos para a revisão (o documento completo não volta à tela). */
export function maskedDocumentTail(raw: string, t: LegalType): string {
  const d = onlyDigits(raw);
  return d ? `${documentLabel(t)} ••• ${d.slice(-4)}` : "";
}

/** Máscara progressiva de celular: (11) 91234-5678. Aceita +55 colado. */
export function maskPhone(raw: string): string {
  let d = onlyDigits(raw);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d ? `(${d}` : "";
  const ddd = `(${d.slice(0, 2)}) `;
  const rest = d.slice(2);
  // Só celular é aceito (9 + 8 dígitos): o hífen entra depois do 5º dígito.
  return rest.length <= 5 ? ddd + rest : `${ddd}${rest.slice(0, 5)}-${rest.slice(5)}`;
}

/** Completa "https://" em endereço digitado sem protocolo. */
export function normalizeWebsite(raw: string): string {
  const v = raw.trim();
  if (!v || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  return `https://${v}`;
}

export const stripAt = (raw: string) => raw.trim().replace(/^@+/, "");

// ── Reenvio de cadastro recusado ──

const AREA_STEP: Record<OrganizerReviewArea, ApplicationDataStep | null> = { PROFILE: 1, BRAND: 2, LEGAL: 3, CONTACT: 4, OTHER: null };

/** Passo escolhido pelo admin ao recusar; `null` = sem área (recusa antiga ou "Outro"). */
export function stepForReviewArea(area: OrganizerReviewArea | null | undefined): ApplicationDataStep | null {
  return area ? (AREA_STEP[area] ?? null) : null;
}

/** Passo mais ligado ao motivo (texto livre do admin); `null` = sem pista. */
export function stepForRejection(reason: string | null | undefined): ApplicationDataStep | null {
  if (!reason) return null;
  const t = reason
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  if (/\b(cpf|cnpj|documento|razao social|nome completo|nome legal|dados legais|fiscal|receita)/.test(t)) return 3;
  if (/\b(tipo de cadastro|pessoa fisica|pessoa juridica)/.test(t)) return 1;
  if (/\b(e-?mail|telefone|celular|whats|contato|site|instagram|redes?)\b/.test(t)) return 4;
  if (/\b(nome|marca|descri|cidade|sede|perfil|bio)/.test(t)) return 2;
  return null;
}

// ── Rascunho neste navegador ──
// Nunca guarda o CPF/CNPJ nem o nome legal (dados pessoais em aparelho que pode
// ser compartilhado). Expira em 7 dias.

export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_VERSION = 1;

export type DraftValues = Omit<ApplicationValues, "document" | "legalName">;
export interface ApplicationDraft {
  v: number;
  savedAt: number;
  step: ApplicationStep;
  values: DraftValues;
}

export const draftKey = (userId: string, organizationId?: string) => `ticket24:cadastro-organizador:v${DRAFT_VERSION}:${userId}:${organizationId ?? "nova"}`;

export function toDraft(step: ApplicationStep, v: ApplicationValues, now = Date.now()): ApplicationDraft {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { document, legalName, ...safe } = v;
  return { v: DRAFT_VERSION, savedAt: now, step, values: safe };
}

export function parseDraft(raw: string | null, now = Date.now()): ApplicationDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as ApplicationDraft;
    if (d?.v !== DRAFT_VERSION || typeof d.savedAt !== "number" || now - d.savedAt > DRAFT_TTL_MS || !d.values) return null;
    const step = Number(d.step);
    const values = Object.fromEntries(Object.entries(d.values).filter(([k, val]) => k !== "document" && k !== "legalName" && typeof val === "string")) as Partial<DraftValues>;
    if (values.legalType !== "COMPANY" && values.legalType !== "INDIVIDUAL") delete values.legalType;
    return { ...d, step: (step >= 1 && step <= 5 ? step : 1) as ApplicationStep, values: values as DraftValues };
  } catch {
    return null;
  }
}

export function readDraft(key: string): ApplicationDraft | null {
  try {
    return parseDraft(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

export function writeDraft(key: string, draft: ApplicationDraft) {
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {}
}

export function removeDraft(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {}
}
