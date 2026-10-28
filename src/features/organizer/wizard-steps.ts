// Assistente de criação de evento: etapas e validação por etapa.
// Compartilhado entre o navegador (validação ao continuar/autosave) e o servidor
// (que SEMPRE revalida). As mensagens reaproveitam os campos de `eventInputSchema`.
import { z } from "zod";
import { eventInputSchema, venueInputSchema } from "@/features/schemas";

export const WIZARD_STEPS = [
  {
    n: 1,
    title: "Informações básicas",
    short: "Básico",
    hint: "Nome, categoria e um resumo curto do evento.",
  },
  {
    n: 2,
    title: "Data e localização",
    short: "Data e local",
    hint: "Quando e onde o evento acontece.",
  },
  {
    n: 3,
    title: "Ingressos e preços",
    short: "Ingressos",
    hint: "Capacidade, período de vendas e tipos de ingresso.",
  },
  {
    n: 4,
    title: "Imagens e descrição",
    short: "Descrição",
    hint: "Capa, descrição completa e classificação indicativa.",
  },
  {
    n: 5,
    title: "Configurações",
    short: "Configurações",
    hint: "Política de cancelamento e reembolso.",
  },
  {
    n: 6,
    title: "Revisão e publicação",
    short: "Revisão",
    hint: "Confira tudo e envie para publicação.",
  },
] as const;

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
/** Etapas com dados; a 6 é só revisão. */
export type DataStep = 1 | 2 | 3 | 4 | 5;
export const DATA_STEPS: readonly DataStep[] = [1, 2, 3, 4, 5];
export const REVIEW_STEP: WizardStep = 6;

export function isDataStep(n: number): n is DataStep {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

/** Primeira etapa ainda não concluída (6 = tudo pronto para revisar). */
export function firstIncompleteStep(completed: readonly number[]): WizardStep {
  return DATA_STEPS.find((s) => !completed.includes(s)) ?? REVIEW_STEP;
}

/** Até onde o organizador pode ir: etapas concluídas e a primeira pendente. */
export function clampStep(requested: number | undefined, completed: readonly number[]): WizardStep {
  const max = firstIncompleteStep(completed);
  if (requested && (requested === max || (isDataStep(requested) && completed.includes(requested)))) return requested as WizardStep;
  return max;
}

export const DEFAULT_REFUND_POLICY = "Reembolso integral em até 7 dias após a compra, desde que solicitado até 48 horas antes do início do evento. Em caso de cancelamento, reembolso automático.";

const s = eventInputSchema.shape;

// Endereço do novo local em partes (rua, número, complemento) para ficar didático;
// o banco guarda uma linha só (`addressLine`), montada por `composeAddressLine`.
export const wizardVenueSchema = z.object({
  name: venueInputSchema.shape.name,
  street: z.string().trim().min(3, "Informe a rua").max(150),
  number: z.string().trim().min(1, "Informe o número (ou S/N)").max(20),
  complement: z.string().trim().max(60).optional(),
  district: venueInputSchema.shape.district,
  postalCode: venueInputSchema.shape.postalCode,
  cityId: venueInputSchema.shape.cityId,
});
export type WizardVenue = z.input<typeof wizardVenueSchema>;

export function composeAddressLine(v: { street: string; number: string; complement?: string }) {
  const base = `${v.street.trim()}, ${v.number.trim()}`;
  return v.complement?.trim() ? `${base} – ${v.complement.trim()}` : base;
}

/** Inverso de `composeAddressLine` (endereços montados pelo assistente). */
export function splitAddressLine(line: string): {
  street: string;
  number: string;
  complement: string;
} {
  const m = /^(.*), ([^,–]+?)(?: – (.*))?$/.exec(line);
  return m ? { street: m[1], number: m[2], complement: m[3] ?? "" } : { street: line, number: "", complement: "" };
}

export const step1Schema = z.object({
  title: s.title,
  categoryId: s.categoryId,
  summary: s.summary,
});

export const step2Schema = z
  .object({
    timezone: s.timezone,
    startsAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Informe data e horário de início"),
    endsAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Informe data e horário de término"),
    locationType: s.locationType,
    venueMode: z.enum(["existing", "new"]).default("existing"),
    venueId: z.string().optional(),
    newVenue: wizardVenueSchema.optional(),
    onlineUrl: s.onlineUrl,
  })
  .superRefine((v, ctx) => {
    if (v.endsAtLocal <= v.startsAtLocal)
      ctx.addIssue({
        code: "custom",
        path: ["endsAtLocal"],
        message: "O término deve ser depois do início",
      });
    if (v.locationType === "VENUE" && v.venueMode === "existing" && !v.venueId)
      ctx.addIssue({
        code: "custom",
        path: ["venueId"],
        message: "Selecione o local",
      });
    if (v.locationType === "VENUE" && v.venueMode === "new" && !v.newVenue)
      ctx.addIssue({
        code: "custom",
        path: ["newVenue", "name"],
        message: "Informe o local",
      });
    if (v.locationType === "ONLINE" && !v.onlineUrl)
      ctx.addIssue({
        code: "custom",
        path: ["onlineUrl"],
        message: "Informe o link de transmissão",
      });
  });

export const step3Schema = z
  .object({
    capacity: s.capacity,
    halfPriceQuotaPercent: z.preprocess((v) => (v === "" || v === null ? undefined : v), s.halfPriceQuotaPercent),
    salesStartLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Informe quando as vendas começam"),
    salesEndLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Informe quando as vendas terminam"),
    // Contexto da etapa 2 (só para a regra "vendas até o fim do evento").
    endsAtLocal: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.salesEndLocal <= v.salesStartLocal)
      ctx.addIssue({
        code: "custom",
        path: ["salesEndLocal"],
        message: "O fim das vendas deve ser depois do início",
      });
    if (v.endsAtLocal && v.salesEndLocal > v.endsAtLocal)
      ctx.addIssue({
        code: "custom",
        path: ["salesEndLocal"],
        message: "As vendas devem terminar até o fim do evento",
      });
  });

export const step4Schema = z.object({
  description: s.description,
  coverImageUrl: s.coverImageUrl,
  ageRestriction: s.ageRestriction,
  accessibilityInfo: s.accessibilityInfo,
});

export const step5Schema = z.object({
  refundPolicy: s.refundPolicy,
  refundWindowDays: s.refundWindowDays,
  refundMinHoursBeforeEvent: s.refundMinHoursBeforeEvent,
});

export const STEP_SCHEMAS = {
  1: step1Schema,
  2: step2Schema,
  3: step3Schema,
  4: step4Schema,
  5: step5Schema,
} as const;

/** Campos de cada etapa no formulário (para mostrar erros e focar o primeiro inválido). */
export const STEP_FIELDS: Record<DataStep, readonly string[]> = {
  1: ["title", "categoryId", "summary"],
  2: ["timezone", "startsAtLocal", "endsAtLocal", "locationType", "venueMode", "venueId", "newVenue", "onlineUrl"],
  3: ["capacity", "halfPriceQuotaPercent", "salesStartLocal", "salesEndLocal"],
  4: ["description", "coverImageUrl", "ageRestriction", "accessibilityInfo"],
  5: ["refundPolicy", "refundWindowDays", "refundMinHoursBeforeEvent"],
};

/** Todos os valores do assistente (estado único do formulário no navegador). */
export interface WizardValues {
  title: string;
  categoryId: string;
  summary: string;
  timezone: string;
  startsAtLocal: string;
  endsAtLocal: string;
  locationType: "VENUE" | "ONLINE";
  venueMode: "existing" | "new";
  venueId: string;
  newVenue: {
    name: string;
    street: string;
    number: string;
    complement: string;
    district: string;
    postalCode: string;
    cityId: string;
  };
  onlineUrl: string;
  capacity: string;
  halfPriceQuotaPercent: string;
  salesStartLocal: string;
  salesEndLocal: string;
  description: string;
  coverImageUrl: string;
  ageRestriction: string;
  accessibilityInfo: string;
  refundPolicy: string;
  refundWindowDays: string;
  refundMinHoursBeforeEvent: string;
}

/** Recorta os valores de uma etapa no formato que a ação do servidor espera. */
export function stepPayload(step: DataStep, v: WizardValues): Record<string, unknown> {
  switch (step) {
    case 1:
      return { title: v.title, categoryId: v.categoryId, summary: v.summary };
    case 2:
      return {
        timezone: v.timezone,
        startsAtLocal: v.startsAtLocal,
        endsAtLocal: v.endsAtLocal,
        locationType: v.locationType,
        venueMode: v.venueMode,
        venueId: v.locationType === "VENUE" && v.venueMode === "existing" ? v.venueId || undefined : undefined,
        newVenue: v.locationType === "VENUE" && v.venueMode === "new" ? v.newVenue : undefined,
        onlineUrl: v.locationType === "ONLINE" ? v.onlineUrl : undefined,
      };
    case 3:
      return {
        capacity: v.capacity,
        halfPriceQuotaPercent: v.halfPriceQuotaPercent,
        salesStartLocal: v.salesStartLocal,
        salesEndLocal: v.salesEndLocal,
        endsAtLocal: v.endsAtLocal || undefined,
      };
    case 4:
      return {
        description: v.description,
        coverImageUrl: v.coverImageUrl,
        ageRestriction: v.ageRestriction,
        accessibilityInfo: v.accessibilityInfo,
      };
    case 5:
      return {
        refundPolicy: v.refundPolicy,
        refundWindowDays: v.refundWindowDays,
        refundMinHoursBeforeEvent: v.refundMinHoursBeforeEvent,
      };
  }
}

/** Erros por campo ("newVenue.street" etc.) para o formulário. */
export function validateStep(step: DataStep, v: WizardValues): Record<string, string> {
  const res = STEP_SCHEMAS[step].safeParse(stepPayload(step, v));
  if (res.success) return {};
  const out: Record<string, string> = {};
  for (const issue of res.error.issues) {
    const key = issue.path.join(".");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
