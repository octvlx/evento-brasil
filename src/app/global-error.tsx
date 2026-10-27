"use client";

// Substitui o layout raiz: não há CSS global nem fontes aqui, por isso estilos inline.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#ffffff", color: "#14112b" }}>
        <main role="alert" style={{ maxWidth: 480, margin: "0 auto", padding: "96px 16px", textAlign: "center" }}>
          <title>Algo deu errado | Evento Brasil</title>
          <h1 style={{ fontSize: 28, margin: "0 0 8px" }}>Algo deu errado</h1>
          <p style={{ color: "#5f5a7a", margin: 0 }}>Não foi possível carregar o Evento Brasil agora. Tente novamente em instantes.</p>
          {error.digest && <p style={{ color: "#5f5a7a", fontSize: 12 }}>Código do erro: {error.digest}</p>}
          <button
            type="button"
            onClick={() => reset()}
            style={{ marginTop: 24, padding: "12px 20px", borderRadius: 12, border: 0, background: "#7c3aed", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" }}
          >
            Tentar novamente
          </button>
        </main>
      </body>
    </html>
  );
}
