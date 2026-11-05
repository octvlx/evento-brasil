import "server-only";
import { AppError } from "../errors";
import { detectImageType, imageDimensions, MAX_IMAGE_BYTES, storeImageBytes } from "../storage";
import { ExternalFetchError, HTML_TYPES, safeFetchResource, type SafeFetchOptions } from "./safe-fetch";
import { cleanText, decodeEntities, metaContent } from "./text";

// Capa de evento externo a partir de uma URL colada pelo admin: a URL direta da imagem
// (com ou sem extensão) ou o link da página do evento. Na página, os metadados (og:image)
// nem sempre são a capa exibida: na Duoticket, og:image é uma versão quadrada "perfil" e a
// capa da página é outra imagem ("capa", 2:1). Por isso juntamos os candidatos (metadados +
// imagens da página, inclusive as carregadas sob demanda em data-src), baixamos os melhores
// com as mesmas proteções da coleta e escolhemos pela pontuação; o admin confirma na prévia.

const IMAGE_OR_HTML = /^(text\/html|application\/xhtml\+xml|image\/|application\/octet-stream|binary\/octet-stream)/;
const IMAGE_TYPES = /^(image\/|application\/octet-stream|binary\/octet-stream)/;
const MAX_CANDIDATES_DOWNLOADED = 5;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 100;

export interface CoverCandidate {
  url: string;
  width: number;
  height: number;
  type: string;
  /** Por que foi pontuado assim (exibido no admin, em linguagem simples). */
  hint: string;
}

export interface CoverPreview {
  /** "direct": a URL já era a imagem; "page": candidatos extraídos da página. */
  kind: "direct" | "page";
  candidates: CoverCandidate[];
}

type FetchOpts = Partial<Pick<SafeFetchOptions, "fetchImpl" | "resolveHost" | "sleep">>;

const PENALTY = /(logo|perfil|profile|avatar|icon|favicon|sprite|loading|loagind|placeholder|banner-home|pixel|tracking|badge|selo|app-store|appstore|google-play|googleplay)/i;
// Pixels de rastreamento e anúncios: nunca são capa e não devem receber requisição nossa.
const TRACKERS = /(^|\.)(facebook\.com|facebook\.net|google-analytics\.com|googletagmanager\.com|doubleclick\.net|googleadservices\.com|tiktok\.com|hotjar\.com|clarity\.ms|bing\.com)$/i;
const BONUS = /(capa|cover|banner|hero|destaque|flyer|poster)/i;

function normalize(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function absoluteHttps(raw: string, base: string): string | null {
  const v = decodeEntities(raw.trim());
  if (!v || v.startsWith("data:") || v.startsWith("blob:")) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol === "http:") u.protocol = "https:";
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (/\.(svg|gif|ico)(\?|$)/i.test(u.pathname)) return null;
    if (TRACKERS.test(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Candidatos a capa na página, com pontuação inicial (antes de baixar). */
export function findCoverCandidates(html: string, pageUrl: string, title?: string | null): { url: string; score: number; hint: string }[] {
  const found = new Map<string, { url: string; score: number; reasons: string[]; seen: number }>();
  const add = (raw: string | null | undefined, score: number, reason: string) => {
    const url = raw ? absoluteHttps(raw, pageUrl) : null;
    if (!url) return;
    const c = found.get(url) ?? { url, score: 0, reasons: [], seen: 0 };
    c.score = Math.max(c.score, score);
    c.seen++;
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
    found.set(url, c);
  };
  add(metaContent(html, "og:image:secure_url"), 3, "metadados da página");
  add(metaContent(html, "og:image"), 3, "metadados da página");
  add(metaContent(html, "twitter:image"), 2, "metadados da página");
  const linkImage = /<link[^>]+rel=["']image_src["'][^>]*>/i.exec(html)?.[0];
  add(linkImage && /href=["']([^"']+)["']/i.exec(linkImage)?.[1], 2, "metadados da página");

  const wanted = title ? normalize(title) : "";
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name: string) => new RegExp(`\\s${name}=["']([^"']+)["']`, "i").exec(tag)?.[1] ?? null;
    const alt = attr("alt") ? normalize(cleanText(attr("alt")!)) : "";
    const matchesTitle = !!wanted && !!alt && (alt.includes(wanted) || wanted.includes(alt));
    const score = matchesTitle ? 6 : 1;
    const reason = matchesTitle ? "imagem da página com o nome do evento" : "imagem da página";
    for (const name of ["data-src", "data-lazy-src", "data-original", "src"]) add(attr(name), score, reason);
    const srcset = attr("srcset") ?? attr("data-srcset");
    if (srcset) add(srcset.split(",").pop()?.trim().split(/\s+/)[0], score, reason);
  }

  return [...found.values()]
    .map((c) => {
      let score = c.score + Math.min(c.seen - 1, 2);
      if (PENALTY.test(c.url)) score -= 5;
      if (BONUS.test(c.url)) score += 2;
      return { url: c.url, score, hint: c.reasons.join(" + ") };
    })
    .sort((a, b) => b.score - a.score);
}

/** Baixa e valida uma imagem (conteúdo, tamanho e dimensões mínimas). */
export async function downloadImage(url: string, opts: FetchOpts = {}) {
  let res;
  try {
    res = await safeFetchResource(url, { allowedHosts: "public", accept: IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES, retries: 1, timeoutMs: 15_000, ...opts });
  } catch (e) {
    throw friendly(e);
  }
  return validateImage(res.url, res.bytes);
}

function validateImage(url: string, bytes: Uint8Array) {
  const type = detectImageType(bytes);
  if (!type) throw new AppError("VALIDATION", "O endereço não aponta para uma imagem JPG, PNG ou WebP válida.");
  const dims = imageDimensions(bytes);
  if (!dims) throw new AppError("VALIDATION", "Não foi possível ler as dimensões da imagem (arquivo inválido ou incompleto).");
  if (dims.width < MIN_WIDTH || dims.height < MIN_HEIGHT) throw new AppError("VALIDATION", `Imagem pequena demais (${dims.width}×${dims.height}). Use uma capa com pelo menos ${MIN_WIDTH}×${MIN_HEIGHT} pixels.`);
  return { url, bytes, type, ...dims };
}

function friendly(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ExternalFetchError) {
    const msg = {
      blocked: "Endereço não permitido: use um link https público (endereços locais, de rede interna e redirecionamentos para eles são bloqueados).",
      timeout: "O site demorou demais para responder. Tente de novo ou envie o arquivo da imagem.",
      http: `O site respondeu com erro (${e.status ?? "?"}). Confira o link ou envie o arquivo da imagem.`,
      too_large: "O conteúdo é grande demais (máximo 5 MB).",
      network: "Não foi possível acessar o endereço. Confira o link ou envie o arquivo da imagem.",
      content_type: "O link não é uma imagem nem uma página de evento.",
    }[e.kind];
    return new AppError("VALIDATION", msg);
  }
  return new AppError("VALIDATION", "Não foi possível obter a imagem desse endereço.");
}

/**
 * Prévia: a URL é uma imagem (direta, com ou sem extensão) ou uma página. Na página,
 * baixa os melhores candidatos e devolve os válidos, o mais provável primeiro.
 */
export async function previewCover(input: string, title?: string | null, opts: FetchOpts = {}): Promise<CoverPreview> {
  let res;
  try {
    res = await safeFetchResource(input.trim(), { allowedHosts: "public", accept: IMAGE_OR_HTML, maxBytes: MAX_IMAGE_BYTES, retries: 1, timeoutMs: 15_000, ...opts });
  } catch (e) {
    throw friendly(e);
  }
  if (!HTML_TYPES.test(res.contentType)) {
    const img = validateImage(res.url, res.bytes);
    return { kind: "direct", candidates: [{ url: img.url, width: img.width, height: img.height, type: img.type, hint: "URL direta da imagem" }] };
  }

  const html = new TextDecoder("utf-8", { fatal: false }).decode(res.bytes);
  const found = findCoverCandidates(html, res.url, title).slice(0, MAX_CANDIDATES_DOWNLOADED);
  const valid: (CoverCandidate & { score: number })[] = [];
  for (const c of found) {
    try {
      const img = await downloadImage(c.url, opts);
      const ratio = img.width / img.height;
      // Capa de evento costuma ser larga; quadrado (perfil/flyer) vem depois.
      const score = c.score + (ratio >= 1.4 ? 3 : ratio >= 1.1 ? 1 : 0) + (img.width * img.height >= 300_000 ? 1 : 0);
      valid.push({ url: c.url, width: img.width, height: img.height, type: img.type, hint: c.hint, score });
    } catch {
      // Candidato inválido (não é imagem, pequeno, bloqueado): ignorado.
    }
  }
  if (!valid.length) throw new AppError("VALIDATION", "Não encontramos uma imagem de capa válida nessa página. Cole a URL direta da imagem ou envie o arquivo.");
  valid.sort((a, b) => b.score - a.score);
  return { kind: "page", candidates: valid.map(({ url, width, height, type, hint }) => ({ url, width, height, type, hint })) };
}

/** Copia a imagem confirmada para o armazenamento da plataforma e devolve a URL própria. */
export async function importCoverImage(imageUrl: string, opts: FetchOpts = {}) {
  const img = await downloadImage(imageUrl.trim(), opts);
  const stored = await storeImageBytes("external", img.bytes);
  return { url: stored.url, width: img.width, height: img.height };
}

/** Upload de arquivo (mesmas regras do upload de capa dos organizadores). */
export async function storeUploadedCover(file: File) {
  if (file.size > MAX_IMAGE_BYTES) throw new AppError("VALIDATION", "Imagem muito grande (máximo 5 MB).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  validateImage("upload", bytes);
  return (await storeImageBytes("external", bytes)).url;
}
