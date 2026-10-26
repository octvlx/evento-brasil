import { ImageResponse } from "next/og";

export const alt = "Evento Brasil — ingressos para shows, festas, teatro e mais";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Cores dos tokens de globals.css (hero-from/via/to) como valores literais.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 80,
          color: "#ffffff",
          background: "linear-gradient(135deg, #1e1b4b 0%, #4c1d95 55%, #be185d 100%)",
        }}
      >
        <div style={{ display: "flex", fontSize: 96, fontWeight: 800, letterSpacing: -2 }}>Evento Brasil</div>
        <div style={{ display: "flex", marginTop: 24, fontSize: 40, color: "#f1effa" }}>Ingressos para shows, festas, teatro e muito mais</div>
        <div style={{ display: "flex", marginTop: 40, fontSize: 28, color: "#fb7185" }}>Compre com PIX ou cartão</div>
      </div>
    ),
    size,
  );
}
