import { ImageResponse } from "next/og";
import { BRAND, BRAND_COLORS as C } from "@/lib/brand";

export const alt = `${BRAND.name} — ${BRAND.tagline.toLowerCase()}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Imagem de compartilhamento: noite → ameixa → pink, símbolo do ingresso e o "24" em limão.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          color: "#ffffff",
          background: `linear-gradient(140deg, ${C.night} 10%, ${C.plum} 60%, ${C.berry} 100%)`,
        }}
      >
        <svg width="120" height="120" viewBox="0 0 32 32">
          <rect width="32" height="32" rx="9" fill={C.night} />
          <rect x="4" y="8" width="24" height="16" rx="3" fill={C.lime} />
          <circle cx="4" cy="16" r="2.6" fill={C.night} />
          <circle cx="28" cy="16" r="2.6" fill={C.night} />
          <path d="M9.9 13.7a2.65 2.65 0 0 1 5.3 0c0 1.5-1.1 2.4-2.4 3.5L9.9 20h5.4" fill="none" stroke={C.night} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M21.4 20.3V11.4l-4.3 6.2h6.1" fill="none" stroke={C.night} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 120, fontWeight: 800, letterSpacing: -3 }}>
            <span>TICKET</span>
            <span style={{ color: C.lime }}>24</span>
          </div>
          <div style={{ display: "flex", marginTop: 16, fontSize: 44, color: "#f3eefb" }}>{BRAND.tagline}</div>
          <div style={{ display: "flex", marginTop: 32, fontSize: 30, color: C.lime }}>Shows, festas, teatro e muito mais · PIX ou cartão</div>
        </div>
      </div>
    ),
    size,
  );
}
