"use client";

import { BRAND, BRAND_COLORS as C } from "@/lib/brand";

// Substitui o layout raiz: não há CSS global nem fontes aqui, por isso estilos inline.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: C.paper, color: C.night }}>
        <main role="alert" style={{ maxWidth: 480, margin: "0 auto", padding: "96px 16px", textAlign: "center" }}>
          <title>{`Algo deu errado | ${BRAND.name}`}</title>
          <p style={{ margin: "0 0 16px", fontSize: 22, fontWeight: 800, letterSpacing: -1 }}>
            <span style={{ color: C.pink }}>QQ</span>Pega
          </p>
          <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Algo deu errado</h1>
          <p style={{ color: C.mutedText, margin: 0 }}>Não conseguimos carregar o {BRAND.name} agora. Tente novamente em instantes.</p>
          {error.digest && <p style={{ color: C.mutedText, fontSize: 12 }}>Código do erro: {error.digest}</p>}
          <button
            type="button"
            onClick={() => reset()}
            style={{ marginTop: 24, padding: "12px 20px", borderRadius: 999, border: 0, background: C.night, color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" }}
          >
            Tentar novamente
          </button>
        </main>
      </body>
    </html>
  );
}
