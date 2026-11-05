import "server-only";
import { lookup } from "node:dns/promises";
import net from "node:net";

// Busca HTTP para coleta de fontes externas. Tudo que vem de fora é não confiável:
// - só HTTPS e só para os hosts autorizados da fonte (inclusive em cada redirecionamento);
// - o host precisa resolver para endereços públicos (bloqueia localhost, redes privadas,
//   link-local, metadados de nuvem etc.);
// - timeout por requisição, tamanho máximo da resposta e tentativas com espera progressiva.
// Limitação conhecida: o DNS é conferido antes da conexão (sem fixar o IP), então um
// rebinding entre a checagem e a conexão não é impedido aqui; a lista de hosts fecha o risco.

export class ExternalFetchError extends Error {
  constructor(
    message: string,
    readonly kind: "blocked" | "timeout" | "http" | "too_large" | "network" | "content_type",
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface SafeFetchOptions {
  /**
   * Hosts exatos permitidos (minúsculos), ex.: ["duoticket.com.br", "www.duoticket.com.br"],
   * ou "public": qualquer host com nome (nunca IP literal) que resolva só para endereços públicos.
   */
  allowedHosts: readonly string[] | "public";
  timeoutMs?: number;
  maxBytes?: number;
  /** Tentativas extras para falhas temporárias (rede, 429, 5xx). */
  retries?: number;
  backoffMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Injeção para testes. */
  fetchImpl?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
}

export const EXTERNAL_USER_AGENT = "QQPegaBot/1.0 (descoberta de eventos; respeita robots.txt)";

const defaults = { timeoutMs: 15_000, maxBytes: 1_500_000, retries: 2, backoffMs: 1_000, maxRedirects: 3 };

/** Endereço que não pode ser alvo de coleta (local, privado, reservado, multicast…). */
export function isBlockedAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isBlockedAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/** Confere esquema, credenciais, porta, host autorizado e resolução para endereço público. */
export async function assertFetchableUrl(raw: string, opts: Pick<SafeFetchOptions, "allowedHosts" | "resolveHost">): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExternalFetchError("URL inválida.", "blocked");
  }
  if (url.protocol !== "https:") throw new ExternalFetchError("Só HTTPS é permitido.", "blocked");
  if (url.username || url.password) throw new ExternalFetchError("URL com credenciais não é permitida.", "blocked");
  if (url.port && url.port !== "443") throw new ExternalFetchError("Porta não permitida.", "blocked");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const listed = opts.allowedHosts === "public" ? /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local") && !host.endsWith(".internal") : opts.allowedHosts.includes(host);
  if (net.isIP(host) || !listed) throw new ExternalFetchError(`Host não autorizado: ${host}`, "blocked");
  const addresses = await (opts.resolveHost ?? defaultResolve)(host).catch(() => {
    throw new ExternalFetchError(`Não foi possível resolver ${host}.`, "network");
  });
  if (!addresses.length || addresses.some(isBlockedAddress)) throw new ExternalFetchError(`O host ${host} aponta para endereço não permitido.`, "blocked");
  return url;
}

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ExternalFetchError("Resposta grande demais.", "too_large");
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ExternalFetchError("Resposta grande demais.", "too_large");
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const sleepDefault = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FetchedResource {
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * GET com todas as proteções acima. `accept` decide os tipos de conteúdo aceitos
 * (o conteúdo de imagens ainda é conferido pela assinatura do arquivo por quem chama).
 */
export async function safeFetchResource(raw: string, options: SafeFetchOptions & { accept: RegExp }): Promise<FetchedResource> {
  const o = { ...defaults, ...options };
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? sleepDefault;
  let lastError: ExternalFetchError | null = null;

  for (let attempt = 0; attempt <= o.retries; attempt++) {
    if (attempt > 0) await sleep(o.backoffMs * 2 ** (attempt - 1));
    try {
      let current = raw;
      for (let hop = 0; ; hop++) {
        const url = await assertFetchableUrl(current, o);
        let res: Response;
        try {
          res = await doFetch(url, {
            method: "GET",
            redirect: "manual",
            headers: { "user-agent": o.userAgent ?? EXTERNAL_USER_AGENT, accept: ACCEPT_HEADER },
            signal: AbortSignal.timeout(o.timeoutMs),
            cache: "no-store",
          });
        } catch (error) {
          const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
          throw new ExternalFetchError(timeout ? "Tempo esgotado." : "Falha de rede.", timeout ? "timeout" : "network");
        }
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location || hop >= o.maxRedirects) throw new ExternalFetchError("Redirecionamento inválido ou excessivo.", "blocked");
          current = new URL(location, url).toString();
          continue;
        }
        if (!res.ok) throw new ExternalFetchError(`HTTP ${res.status}`, "http", res.status);
        const type = (res.headers.get("content-type") ?? "").toLowerCase();
        if (!o.accept.test(type)) throw new ExternalFetchError(`Tipo de conteúdo não aceito (${type.slice(0, 40) || "não informado"}).`, "content_type");
        return { url: url.toString(), contentType: type, bytes: await readLimited(res, o.maxBytes) };
      }
    } catch (error) {
      lastError = error instanceof ExternalFetchError ? error : new ExternalFetchError("Falha inesperada.", "network");
      const transient = lastError.kind === "network" || lastError.kind === "timeout" || (lastError.kind === "http" && (lastError.status === 429 || (lastError.status ?? 0) >= 500));
      if (!transient) break;
    }
  }
  throw lastError ?? new ExternalFetchError("Falha inesperada.", "network");
}

/**
 * Só formatos que sabemos validar. Sem "image/avif": CDNs de imagem com negociação
 * (ex.: Cloudflare Images) entregariam AVIF, que a checagem por assinatura recusa.
 */
export const ACCEPT_HEADER = "text/html,application/xhtml+xml,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.5";

export const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)/;

/** GET de uma página HTML com todas as proteções acima. Devolve o HTML e a URL final. */
export async function safeFetchHtml(raw: string, options: SafeFetchOptions): Promise<{ url: string; html: string }> {
  const r = await safeFetchResource(raw, { ...options, accept: HTML_TYPES });
  return { url: r.url, html: new TextDecoder("utf-8", { fatal: false }).decode(r.bytes) };
}
