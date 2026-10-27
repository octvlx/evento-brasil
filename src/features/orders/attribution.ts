// Cookie de atribuição de venda (ADR 0002, D5): primário, sem dado pessoal.
// Guarda só o id do link rastreado e os UTMs; o serviço de pedidos valida o link
// (descarta link de outro evento) e trunca os UTMs. Último clique vence.
import "server-only";
import { z } from "zod";
import { isProduction } from "@/server/env";

export const ATTR_COOKIE = "eb_attr";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const UTM_MAX = 200;

export interface Attribution {
  trackingLinkId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

const UTM_PARAMS = {
  utm_source: "utmSource",
  utm_medium: "utmMedium",
  utm_campaign: "utmCampaign",
  utm_content: "utmContent",
  utm_term: "utmTerm",
} as const satisfies Record<string, keyof Attribution>;

const utm = z.string().max(UTM_MAX).optional();
const stored = z.object({
  trackingLinkId: z.string().regex(/^[a-z0-9]{1,64}$/).optional(),
  utmSource: utm,
  utmMedium: utm,
  utmCampaign: utm,
  utmContent: utm,
  utmTerm: utm,
});

const cut = (v: string | null | undefined) => v?.trim().slice(0, UTM_MAX) || undefined;

function compact(a: Attribution): Attribution {
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v)) as Attribution;
}

export function encodeAttribution(a: Attribution): string {
  return JSON.stringify(compact(a));
}

/** Valor do cookie → atribuição; qualquer coisa inválida vira "sem atribuição". */
export function decodeAttribution(raw: string | undefined): Attribution | undefined {
  if (!raw) return undefined;
  try {
    const parsed = stored.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const a = compact(parsed.data);
    return Object.keys(a).length ? a : undefined;
  } catch {
    return undefined;
  }
}

/** UTMs soltos de uma URL (sem link cadastrado); undefined quando não há nenhum. */
export function utmsFromParams(params: Record<string, string | string[] | undefined>): Attribution | undefined {
  const a: Attribution = {};
  for (const [param, key] of Object.entries(UTM_PARAMS)) {
    const v = params[param];
    a[key] = cut(Array.isArray(v) ? v[0] : v);
  }
  const out = compact(a);
  return Object.keys(out).length ? out : undefined;
}

export const attributionCookieOptions = () => ({
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: isProduction(),
  maxAge: MAX_AGE_SECONDS,
});
