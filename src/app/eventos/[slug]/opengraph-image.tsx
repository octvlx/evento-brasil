// Imagem de compartilhamento do evento (WhatsApp, redes, buscadores): capa ao fundo com
// véu escuro, título, data no fuso do evento, local, categoria e o selo "A partir de R$ X"
// com o mesmo total da página. Evento inexistente ou fora do ar: a imagem padrão do site.
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/server/db";
import { getPublicEvent } from "@/server/services/catalog";
import { ownCoverDataUri, shareLabels } from "@/server/og/event-share";
import { BRAND, BRAND_COLORS as C } from "@/lib/brand";

export const alt = `Evento na ${BRAND.name}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Fonte da marca (Unbounded ExtraBold, OFL; src/assets/fonts): única fonte passada ao
// gerador, então vale para todos os textos da imagem.
// Não depende da requisição: lida uma vez ao carregar o módulo.
const unbounded = await readFile(join(process.cwd(), "src/assets/fonts/unbounded-latin-800-normal.woff"));
const fonts = [{ name: "Unbounded", data: unbounded, weight: 800 as const, style: "normal" as const }];
const display = { fontFamily: "Unbounded", fontWeight: 800 } as const;

export default async function EventOpengraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getPublicEvent(db, slug);
  if (!data) return fallback();
  const { event, prices, ended, availability } = data;
  const onSale = event.ticketTypes.filter((t) => t.available).map((t) => prices[t.id].totalCents);
  const labels = shareLabels({
    title: event.title,
    startsAt: event.startsAt,
    timezone: event.timezone,
    locationType: event.locationType,
    categoryName: event.category.name,
    city: event.venue?.city ?? event.city,
    venueName: event.venue && !event.venue.isFictional ? event.venue.name : null,
    minTotalCents: onSale.length ? Math.min(...onSale) : null,
    ended,
    soldOut: availability === "SOLD_OUT",
  });
  const cover = await ownCoverDataUri(event.coverImageUrl);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", color: "#ffffff", background: `linear-gradient(140deg, ${C.night} 10%, ${C.plum} 60%, ${C.berry} 100%)` }}>
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" width={1200} height={630} style={{ position: "absolute", top: 0, left: 0, width: 1200, height: 630, objectFit: "cover" }} />
        )}
        {/* Véu: legibilidade do texto sobre qualquer capa. */}
        <div style={{ position: "absolute", top: 0, left: 0, width: 1200, height: 630, display: "flex", background: cover ? "linear-gradient(90deg, rgba(22,18,31,0.94) 0%, rgba(22,18,31,0.82) 55%, rgba(22,18,31,0.45) 100%)" : "transparent" }} />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: "56px 64px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", fontSize: 36, letterSpacing: -1, ...display }}>
              <span>TICKET</span>
              <span style={{ color: C.lime }}>24</span>
            </div>
            <div style={{ display: "flex", fontSize: 26, padding: "8px 20px", borderRadius: 999, border: "2px solid rgba(255,255,255,0.5)" }}>{labels.category}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", maxWidth: 1000 }}>
            <div style={{ display: "flex", fontSize: Math.round(labels.titleSize * 0.82), lineHeight: 1.1, letterSpacing: -1, lineClamp: 3, ...display }}>{event.title}</div>
            <div style={{ display: "flex", marginTop: 24, fontSize: 34, color: C.lime }}>{labels.date}</div>
            {labels.place && <div style={{ display: "flex", marginTop: 8, fontSize: 30, color: "#f3eefb" }}>{labels.place}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", fontSize: 26, color: "rgba(255,255,255,0.8)" }}>ticket24.com.br · PIX ou cartão</div>
            {labels.price && (
              <div style={{ display: "flex", fontSize: 34, fontWeight: 800, padding: "14px 28px", borderRadius: 999, background: ended ? "rgba(255,255,255,0.2)" : C.lime, color: ended ? "#ffffff" : C.night }}>{labels.price}</div>
            )}
          </div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}

function fallback() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#ffffff", background: `linear-gradient(140deg, ${C.night} 10%, ${C.plum} 60%, ${C.berry} 100%)` }}>
        <div style={{ display: "flex", fontSize: 110, letterSpacing: -3, ...display }}>
          <span>TICKET</span>
          <span style={{ color: C.lime }}>24</span>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
