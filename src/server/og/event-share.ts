// Dados da imagem de compartilhamento do evento (/eventos/<slug>/opengraph-image): os
// textos (pura, testável) e a capa do evento, lida só do NOSSO armazenamento.
import "server-only";
import { env } from "../env";
import { MAX_IMAGE_BYTES, detectImageType, readLocalUpload } from "../storage";
import { formatBRL } from "@/lib/money";

type ShareInput = {
  title: string;
  startsAt: Date;
  timezone: string;
  locationType: "VENUE" | "ONLINE";
  categoryName: string;
  city: { name: string; state: string } | null;
  venueName: string | null;
  /** Menor total por ingresso à venda (o mesmo da página); null sem ingresso à venda. */
  minTotalCents: number | null;
  ended: boolean;
  soldOut: boolean;
};

/** Textos da imagem: data no fuso do evento, local e o selo de preço. */
export function shareLabels(e: ShareInput) {
  const f = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { timeZone: e.timezone, ...opts }).format(e.startsAt);
  const weekday = f({ weekday: "short" }).replace(".", "");
  const date = `${weekday}, ${f({ day: "numeric" })} de ${f({ month: "long" })} · ${f({ hour: "2-digit", minute: "2-digit" })}`;
  const place =
    e.locationType === "ONLINE" ? "Evento online" : [e.venueName, e.city ? `${e.city.name} – ${e.city.state}` : null].filter(Boolean).join(" · ") || null;
  const price = e.ended
    ? "Evento encerrado"
    : e.soldOut
      ? "Esgotado"
      : e.minTotalCents === 0
        ? "Gratuito"
        : e.minTotalCents != null
          ? `A partir de ${formatBRL(e.minTotalCents).replace(/ /g, " ")}`
          : null;
  // Títulos longos ficam menores para caber em até 3 linhas.
  const titleSize = e.title.length > 70 ? 54 : e.title.length > 40 ? 66 : 80;
  return { date: date.charAt(0).toUpperCase() + date.slice(1), place, price, category: e.categoryName, titleSize };
}

const OG_TYPES = new Set(["image/jpeg", "image/png"]); // o gerador de imagem não lê WebP

/**
 * Capa do evento como data URI, só quando vem do armazenamento do próprio site:
 * "/uploads/<chave>" (desenvolvimento) ou o endereço público do bucket (produção).
 * O campo da capa aceita texto livre, então nenhuma outra URL é buscada (sem SSRF).
 * Qualquer falha devolve null e a imagem usa o fundo da marca.
 */
export async function ownCoverDataUri(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    let bytes: Uint8Array | null = null;
    if (url.startsWith("/uploads/")) {
      bytes = await readLocalUpload(decodeURIComponent(url.slice("/uploads/".length)));
    } else {
      const base = env().OBJECT_STORAGE_PUBLIC_URL?.replace(/\/$/, "");
      if (!base || !url.startsWith(`${base}/`) || url.includes("..")) return null;
      const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(3000) });
      if (!res.ok || Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES) return null;
      bytes = buf;
    }
    if (!bytes) return null;
    const type = detectImageType(bytes);
    if (!type || !OG_TYPES.has(type)) return null;
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}
