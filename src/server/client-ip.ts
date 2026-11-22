import "server-only";
import { headers } from "next/headers";
import { env } from "./env";

type HeaderSource = Pick<Headers, "get">;

/**
 * IP do cliente para limite de tentativas, auditoria e aceite de termos.
 *
 * Os proxies ACRESCENTAM o endereço que observaram no fim do `x-forwarded-for`; o que
 * vem antes foi enviado pelo próprio cliente e pode ser forjado. Por isso a leitura é
 * da direita para a esquerda: `trustedProxyHops` é quantos proxies nossos ficam entre
 * o proxy de borda da hospedagem e o app (TRUSTED_PROXY_HOPS).
 *
 * - Vercel: sobrescreve o cabeçalho com um único IP → 0.
 * - Cloud Run acessado direto: acrescenta o IP do cliente no fim → 0.
 * - Cloud Run atrás de um Load Balancer externo do Google (cliente, IP do LB) → 1.
 *
 * Sem o cabeçalho (desenvolvimento local), usa `x-real-ip`; sem nenhum, `null`.
 */
export function clientIpFromHeaders(h: HeaderSource, trustedProxyHops = 0): string | null {
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
    // Menos entradas que o esperado: configuração errada; o mais à esquerda é o único que resta.
    const ip = hops[Math.max(0, hops.length - 1 - trustedProxyHops)];
    if (ip) return ip.slice(0, 64);
  }
  return h.get("x-real-ip")?.trim().slice(0, 64) || null;
}

/** IP do cliente da requisição atual (Server Actions e rotas). */
export async function clientIp(source?: HeaderSource): Promise<string | null> {
  return clientIpFromHeaders(source ?? (await headers()), env().TRUSTED_PROXY_HOPS);
}
