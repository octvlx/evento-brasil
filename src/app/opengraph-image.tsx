import { ImageResponse } from "next/og";
import { BRAND, BRAND_COLORS as C } from "@/lib/brand";

export const alt = `${BRAND.name} — ${BRAND.tagline.toLowerCase()}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Imagem de compartilhamento: noite → ameixa → pink, nome em limão e símbolo dos dois "Q".
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
          <circle cx="12.25" cy="15.25" r="5.25" fill="none" stroke={C.lime} strokeWidth="3" />
          <circle cx="20" cy="15.25" r="5.25" fill="none" stroke="#ff4f93" strokeWidth="3" />
          <path d="M23.4 18.65 26.2 21.45" stroke="#ff4f93" strokeWidth="3" strokeLinecap="round" />
          <path d="M14.88 10.7A5.25 5.25 0 0 1 17.01 13.03" fill="none" stroke={C.lime} strokeWidth="3" />
          <path d="M15.65 18.65 18.3 21.3" stroke={C.lime} strokeWidth="3" strokeLinecap="round" />
        </svg>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 120, fontWeight: 800, letterSpacing: -5 }}>
            <span style={{ color: C.lime }}>QQ</span>
            <span>Pega</span>
          </div>
          <div style={{ display: "flex", marginTop: 16, fontSize: 44, color: "#f3eefb" }}>{BRAND.tagline}</div>
          <div style={{ display: "flex", marginTop: 32, fontSize: 30, color: C.lime }}>Shows, festas, teatro e muito mais · PIX ou cartão</div>
        </div>
      </div>
    ),
    size,
  );
}
