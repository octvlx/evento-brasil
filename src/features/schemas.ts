// Schemas Zod compartilhados entre formulários (cliente) e servidor.
// O servidor SEMPRE revalida; nunca confia em preço/estoque vindos do cliente.
import { z } from "zod";
import { BR_TIMEZONES, isValidCNPJ, isValidCPF, isValidMobileBR, UF_CODES } from "@/lib/br";
import { newPasswordSchema, PASSWORD_MAX_LENGTH, PASSWORD_MESSAGES } from "@/lib/password-policy";

const trimmed = (min: number, max: number, msg = "Campo obrigatório") => z.string().trim().min(min, msg).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));
const email = z.string().trim().toLowerCase().email("E-mail inválido").max(200);
const mobile = z
  .string()
  .trim()
  .refine((v) => !v || isValidMobileBR(v), "Celular inválido. Use DDD + número, ex.: (11) 91234-5678");
const emptyToUndefined = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" || v === null ? undefined : v), schema);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Data/hora inválida");

// ── Contas ──
export const registerSchema = z
  .object({
    name: trimmed(2, 120, "Informe seu nome"),
    email,
    // Só confere a digitação do e-mail; nunca é gravado.
    confirmEmail: z.string().trim().toLowerCase().min(1, "Confirme o e-mail"),
    password: newPasswordSchema,
    // Só confere a digitação; nunca é gravado.
    confirmPassword: z.string().min(1, "Confirme a senha"),
    phone: mobile.optional(),
    acceptTerms: z.literal(true, { error: "É preciso aceitar os termos de uso" }),
    acceptPrivacy: z.literal(true, { error: "É preciso aceitar a política de privacidade" }),
  })
  .refine((v) => v.email === v.confirmEmail, { path: ["confirmEmail"], message: "Os e-mails não coincidem." })
  .refine((v) => v.password === v.confirmPassword, { path: ["confirmPassword"], message: PASSWORD_MESSAGES.mismatch });
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.object({ email, password: z.string().min(1, "Informe a senha").max(200) });

export const profileSchema = z.object({ name: trimmed(2, 120), phone: mobile.optional() });

/** Troca de senha em Minha conta: a atual é obrigatória (prova de posse, não só a sessão). */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Informe a senha atual").max(PASSWORD_MAX_LENGTH * 2),
    newPassword: newPasswordSchema,
    confirmPassword: z.string().min(1, "Confirme a nova senha"),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { path: ["confirmPassword"], message: PASSWORD_MESSAGES.newMismatch });
export type ChangePasswordInput = z.input<typeof changePasswordSchema>;

// ── Organizador ──
export const organizerApplicationSchema = z
  .object({
    name: trimmed(2, 120, "Informe o nome público"),
    legalType: z.enum(["INDIVIDUAL", "COMPANY"]),
    legalName: trimmed(2, 200, "Informe o nome/razão social"),
    document: z.string().trim(),
    contactEmail: email,
    contactPhone: mobile.optional(),
    cityId: z.string().optional(),
    description: optionalText(2000),
    websiteUrl: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || /^https:\/\/[^\s]+$/.test(v), "Use um endereço https://"),
    instagramHandle: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || /^@?[A-Za-z0-9._]{1,30}$/.test(v), "Usuário do Instagram inválido"),
  })
  .superRefine((v, ctx) => {
    const ok = v.legalType === "INDIVIDUAL" ? isValidCPF(v.document) : isValidCNPJ(v.document);
    if (!ok) ctx.addIssue({ code: "custom", path: ["document"], message: v.legalType === "INDIVIDUAL" ? "CPF inválido" : "CNPJ inválido" });
  });
export type OrganizerApplicationInput = z.input<typeof organizerApplicationSchema>;

export const inviteSchema = z.object({
  email,
  role: z.enum(["ADMIN", "EVENT_MANAGER", "FINANCE", "CHECKIN_STAFF"]),
  eventId: z.string().optional(),
});

// ── Eventos ──
export const venueInputSchema = z.object({
  name: trimmed(2, 160, "Informe o nome do local"),
  addressLine: trimmed(3, 200, "Informe o endereço"),
  district: optionalText(120),
  postalCode: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^\d{5}-?\d{3}$/.test(v), "CEP inválido"),
  // Município da base local do IBGE (autocomplete). `cityId` (cidade já cadastrada)
  // fica só por compatibilidade; um dos dois é exigido em `requireVenueCity`.
  cityIbgeCode: emptyToUndefined(z.string().trim().regex(/^\d{7}$/, "Selecione a cidade na lista").optional()),
  cityUf: emptyToUndefined(z.enum(UF_CODES, { message: "Selecione a UF" }).optional()),
  cityId: emptyToUndefined(z.string().optional()),
  capacity: z.coerce.number().int().positive().optional(),
  accessibilityInfo: optionalText(1000),
});

/** Novo local sem município escolhido (nem cidade antiga) é recusado. */
export function requireVenueCity(v: { cityIbgeCode?: string; cityUf?: string; cityId?: string } | undefined, ctx: z.RefinementCtx) {
  if (!v || v.cityId) return;
  if (!v.cityUf) ctx.addIssue({ code: "custom", path: ["newVenue", "cityUf"], message: "Selecione a UF" });
  else if (!v.cityIbgeCode) ctx.addIssue({ code: "custom", path: ["newVenue", "cityIbgeCode"], message: "Selecione a cidade na lista" });
}

export const transferPolicyFields = {
  transferDeadlineHours: z.coerce.number({ message: "Informe as horas para transferir" }).int("Use horas inteiras").min(0, "Mínimo de 0 horas").max(8760, "Máximo de 8760 horas").default(24),
  transferMaxTransfers: z.coerce.number({ message: "Informe o limite de transferências" }).int("Use um limite inteiro").min(1, "Permita ao menos 1 transferência").max(10, "Máximo de 10 transferências").default(1),
  transferAllowReturn: z.boolean().default(false),
};

export function validateTransferPolicySettings(v: { transferAllowReturn: boolean; transferMaxTransfers: number }, ctx: z.RefinementCtx) {
  if (v.transferAllowReturn && v.transferMaxTransfers < 2)
    ctx.addIssue({ code: "custom", path: ["transferMaxTransfers"], message: "Para permitir devolução ao titular anterior, permita ao menos 2 transferências." });
}

export const eventInputSchema = z
  .object({
    title: trimmed(3, 140, "Informe o título"),
    summary: optionalText(240),
    description: trimmed(20, 10_000, "Descreva o evento (mínimo 20 caracteres)"),
    categoryId: z.string().min(1, "Selecione a categoria"),
    locationType: z.enum(["VENUE", "ONLINE"]),
    venueId: z.string().optional(),
    newVenue: venueInputSchema.optional(),
    onlineUrl: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || /^https:\/\/[^\s]+$/.test(v), "Use um link https://"),
    cityId: z.string().optional(),
    timezone: z.enum(BR_TIMEZONES),
    startsAtLocal: localDateTime,
    endsAtLocal: localDateTime,
    salesStartLocal: localDateTime,
    salesEndLocal: localDateTime,
    ageRestriction: z.coerce.number().int().min(0).max(21),
    capacity: z.coerce.number().int().positive("Capacidade deve ser positiva").max(1_000_000),
    halfPriceQuotaPercent: z.coerce.number().min(0).max(100).optional(),
    // R4: vazio = sem limite. Com vendas, o servidor recusa valor abaixo do que uma conta já tem.
    maxTicketsPerAccount: z.preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z.coerce
        .number({ message: "Informe um número de ingressos" })
        .int("Use um número inteiro de ingressos")
        .min(1, "O limite deve ser de pelo menos 1 ingresso")
        .max(1000, "Máximo de 1000 ingressos por conta")
        .optional(),
    ),
    // Só exigido (no servidor) em alteração relevante de evento publicado com vendas (R8).
    changeReason: optionalText(2000),
    ...transferPolicyFields,
    refundPolicy: trimmed(10, 4000, "Descreva a política de reembolso"),
    refundWindowDays: z.coerce
      .number({ message: "Informe os dias após a compra" })
      .int("Use um número inteiro de dias")
      .min(0, "Mínimo de 0 dias")
      .max(365, "Máximo de 365 dias")
      .default(7),
    refundMinHoursBeforeEvent: z.coerce
      .number({ message: "Informe as horas antes do evento" })
      .int("Use um número inteiro de horas")
      .min(0, "Mínimo de 0 horas")
      .max(720, "Máximo de 720 horas")
      .default(48),
    accessibilityInfo: optionalText(2000),
    coverImageUrl: z.string().trim().optional(),
  })
  .superRefine((v, ctx) => {
    validateTransferPolicySettings(v, ctx);
    if (v.endsAtLocal <= v.startsAtLocal) ctx.addIssue({ code: "custom", path: ["endsAtLocal"], message: "Término deve ser após o início" });
    if (v.salesEndLocal <= v.salesStartLocal)
      ctx.addIssue({ code: "custom", path: ["salesEndLocal"], message: "Fim das vendas deve ser após o início" });
    if (v.salesEndLocal > v.endsAtLocal)
      ctx.addIssue({ code: "custom", path: ["salesEndLocal"], message: "As vendas devem terminar até o fim do evento" });
    if (v.locationType === "VENUE" && !v.venueId && !v.newVenue)
      ctx.addIssue({ code: "custom", path: ["venueId"], message: "Selecione ou cadastre o local" });
    if (v.locationType === "VENUE" && !v.venueId) requireVenueCity(v.newVenue, ctx);
    if (v.locationType === "ONLINE" && !v.onlineUrl)
      ctx.addIssue({ code: "custom", path: ["onlineUrl"], message: "Informe o link de transmissão" });
  });
export type EventInput = z.input<typeof eventInputSchema>;

export const TICKET_KINDS = ["GENERAL", "VIP", "PROMOTIONAL", "EARLY_BIRD", "HALF_PRICE", "FREE"] as const;

export const ticketTypeInputSchema = z
  .object({
    id: z.string().optional(),
    name: trimmed(2, 80, "Informe o nome do ingresso"),
    description: optionalText(300),
    kind: z.enum(TICKET_KINDS),
    priceCents: z.coerce.number().int().min(0).max(100_000_00),
    quantityTotal: z.coerce.number().int().min(1).max(1_000_000),
    minPerOrder: z.coerce.number().int().min(1).max(50).default(1),
    maxPerOrder: z.coerce.number().int().min(1).max(50).default(10),
    salesStartLocal: localDateTime.optional().or(z.literal("")),
    salesEndLocal: localDateTime.optional().or(z.literal("")),
    requiresAttendeeInfo: z.coerce.boolean().default(false),
    isHidden: z.coerce.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.maxPerOrder < v.minPerOrder) ctx.addIssue({ code: "custom", path: ["maxPerOrder"], message: "Máximo menor que o mínimo" });
    if (v.kind === "FREE" && v.priceCents !== 0) ctx.addIssue({ code: "custom", path: ["priceCents"], message: "Ingresso gratuito deve ter preço zero" });
    if (v.kind !== "FREE" && v.priceCents === 0)
      ctx.addIssue({ code: "custom", path: ["priceCents"], message: "Use o tipo 'Gratuito' para ingressos sem custo" });
  });
export type TicketTypeInput = z.input<typeof ticketTypeInputSchema>;

// ── Cupons e links de divulgação (ADR 0002) ──
export const COUPON_CODE_RE = /^[A-Z0-9_-]{3,32}$/;
const optionalLimit = z.coerce.number().int().min(1).max(1_000_000).nullable().default(null);

export const couponInputSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(COUPON_CODE_RE, "Use de 3 a 32 letras, números, - ou _"),
    description: optionalText(200),
    discountType: z.enum(["PERCENT", "FIXED_PER_TICKET"]),
    // Percentual em pontos-base (1–10000) ou valor fixo em centavos, conforme o tipo.
    percentBps: z.coerce.number().int().min(1).max(10_000).nullable().default(null),
    amountCents: z.coerce.number().int().min(1).max(100_000_00).nullable().default(null),
    validFromLocal: localDateTime.optional().or(z.literal("")),
    validUntilLocal: localDateTime.optional().or(z.literal("")),
    maxUses: optionalLimit,
    maxUsesPerUser: optionalLimit,
    // Vazio = todos os tipos pagos do evento (exceto meia-entrada).
    ticketTypeIds: z.array(z.string().min(1)).max(50).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.discountType === "PERCENT" && v.percentBps === null) ctx.addIssue({ code: "custom", path: ["percentBps"], message: "Informe o percentual de desconto" });
    if (v.discountType === "FIXED_PER_TICKET" && v.amountCents === null)
      ctx.addIssue({ code: "custom", path: ["amountCents"], message: "Informe o valor do desconto" });
    if (v.validFromLocal && v.validUntilLocal && v.validUntilLocal <= v.validFromLocal)
      ctx.addIssue({ code: "custom", path: ["validUntilLocal"], message: "O fim da validade deve ser depois do início" });
  })
  .transform((v) => ({
    ...v,
    percentBps: v.discountType === "PERCENT" ? v.percentBps : null,
    amountCents: v.discountType === "FIXED_PER_TICKET" ? v.amountCents : null,
  }));
export type CouponInput = z.input<typeof couponInputSchema>;

const utm = optionalText(200);
export const trackingLinkInputSchema = z.object({
  name: trimmed(2, 120, "Dê um nome ao link (ex.: Instagram stories)"),
  utmSource: utm,
  utmMedium: utm,
  utmCampaign: utm,
  utmContent: utm,
  utmTerm: utm,
  couponId: z.string().min(1).optional().or(z.literal("")),
});
export type TrackingLinkInput = z.input<typeof trackingLinkInputSchema>;

// ── Pedidos ──
export const attendeeSchema = z.object({ name: trimmed(2, 120, "Nome do participante"), email: email.optional() });

export const createOrderSchema = z.object({
  eventId: z.string().min(1),
  items: z
    .array(
      z.object({
        ticketTypeId: z.string().min(1),
        quantity: z.number().int().min(1).max(50),
        attendees: z.array(attendeeSchema).optional(),
      }),
    )
    .min(1, "Selecione ao menos um ingresso")
    .max(10),
  buyerName: trimmed(2, 120, "Informe o nome do comprador"),
  buyerEmail: email,
  buyerPhone: mobile.optional(),
  // Declaração de elegibilidade à meia-entrada (comprovação exigida na entrada).
  halfPriceDeclaration: z.boolean().default(false),
  idempotencyKey: z.string().uuid(),
  // ADR 0002. Normalizado e validado no serviço (erro genérico para código inválido).
  couponCode: z.string().max(64).optional(),
  // Origem da venda; a Server Action preenche a partir do cookie eb_attr. UTMs são truncados em 200.
  attribution: z
    .object({
      trackingLinkId: z.string().max(64).optional(),
      utmSource: z.string().max(2000).optional(),
      utmMedium: z.string().max(2000).optional(),
      utmCampaign: z.string().max(2000).optional(),
      utmContent: z.string().max(2000).optional(),
      utmTerm: z.string().max(2000).optional(),
    })
    .optional(),
});
export type CreateOrderInput = z.input<typeof createOrderSchema>;

export const commissionRuleInputSchema = z.object({
  scope: z.enum(["PLATFORM", "ORGANIZATION", "EVENT"]),
  organizationId: z.string().optional(),
  eventId: z.string().optional(),
  percent: z.coerce.number().min(0).max(100),
  fixedCentsPerTicket: z.coerce.number().int().min(0).max(100_00).default(0),
  bearer: z.enum(["ORGANIZER", "BUYER"]),
  processingFeeBearer: z.enum(["ORGANIZER", "PLATFORM"]),
  refundCommissionOnRefund: z.coerce.boolean().default(true),
});

export const ufSchema = z.enum(UF_CODES);
