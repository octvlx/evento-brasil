"use client";

// QR dinâmico do ingresso: gerado no celular do titular, assinado com a chave do ingresso
// e trocado a cada QR_STEP_MS. Um print ou foto vence em segundos (a portaria só aceita
// passos recentes). Proteções visuais: relógio ao vivo e anel animado (um print parado
// fica evidente), QR borrado quando a tela perde o foco (inclui a miniatura do alternador
// de apps) e fora da impressão. Bloquear o print em si não é possível num site.
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { bytesToBase64url, dynamicQrMessage, dynamicQrPayload, QR_STEP_MS, qrStep } from "@/lib/qr-payload";

export interface TicketSigningJwk {
  kty: "EC";
  crv: "P-256";
  d: string;
  x: string;
  y: string;
}

export function DynamicTicketQr({ code, jwk, serverNowMs, holderName }: { code: string; jwk: TicketSigningJwk; serverNowMs: number; holderName: string }) {
  // Diferença entre o relógio do servidor e o do celular (celular com hora errada ainda gera QR válido).
  const offset = useRef<number | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [obscured, setObscured] = useState(false);
  const [failed, setFailed] = useState(false);
  const keyRef = useRef<CryptoKey | null>(null);
  const stepRef = useRef<number | null>(null);

  useEffect(() => {
    offset.current = serverNowMs - Date.now();
    let cancelled = false;
    const render = async () => {
      const t = Date.now() + (offset.current ?? 0);
      setNow(t);
      const step = qrStep(t);
      if (step === stepRef.current) return;
      stepRef.current = step;
      try {
        keyRef.current ??= await crypto.subtle.importKey("jwk", { ...jwk, ext: false }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
        const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyRef.current, new TextEncoder().encode(dynamicQrMessage(code, step)));
        const out = await QRCode.toString(dynamicQrPayload(code, step, bytesToBase64url(sig)), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
        if (!cancelled) setSvg(out);
      } catch {
        // Sem WebCrypto (navegador muito antigo ou página fora de HTTPS).
        if (!cancelled) setFailed(true);
      }
    };
    void render();
    const id = window.setInterval(() => void render(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [code, jwk, serverNowMs]);

  useEffect(() => {
    const update = () => setObscured(document.visibilityState !== "visible" || !document.hasFocus());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("blur", update);
    window.addEventListener("focus", update);
    window.addEventListener("pagehide", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("blur", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("pagehide", update);
    };
  }, []);

  const secondsLeft = now === null ? null : Math.ceil((QR_STEP_MS - (now % QR_STEP_MS)) / 1000);
  const clock = useMemo(() => (now === null ? "" : new Date(now).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })), [now]);

  if (failed) {
    return (
      <div className="mx-auto grid size-64 place-items-center rounded-2xl bg-muted p-4 text-sm text-muted-foreground" role="alert">
        Não foi possível gerar o QR neste navegador. Atualize o navegador do celular ou abra o ingresso em outro.
      </div>
    );
  }

  return (
    <div className="select-none" onContextMenu={(e) => e.preventDefault()} data-testid="dynamic-qr">
      {/* Na impressão o QR não sai: só vale na tela, ao vivo. */}
      <div className="relative mx-auto w-64 print:hidden">
        <div className="absolute -inset-1.5 rounded-[1.4rem] bg-[conic-gradient(var(--secondary),var(--accent),var(--secondary))] motion-safe:animate-spin [animation-duration:4s]" aria-hidden />
        <div
          className={`relative rounded-2xl bg-white p-3 transition-[filter] duration-150 [&_svg]:h-auto [&_svg]:w-full ${obscured ? "blur-xl" : ""}`}
          role="img"
          aria-label="QR code do ingresso, atualizado a cada 30 segundos"
          // QR gerado aqui mesmo pela biblioteca (SVG próprio, sem conteúdo de terceiros).
          dangerouslySetInnerHTML={{ __html: svg ?? "" }}
        />
        {!svg && <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Gerando QR…</div>}
        {obscured && svg && (
          <div className="absolute inset-0 grid place-items-center rounded-2xl text-center text-sm font-semibold text-foreground">Toque na tela para mostrar o QR</div>
        )}
      </div>
      <div className="mt-3 flex flex-col items-center gap-1 print:hidden" aria-live="off">
        <p className="font-mono text-2xl font-bold tabular-nums" data-testid="live-clock">
          {clock}
        </p>
        <p className="text-xs text-muted-foreground">
          {holderName} · QR novo em {secondsLeft ?? "…"} s
        </p>
        <div className="h-1 w-40 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full bg-secondary transition-[width] duration-1000 ease-linear" style={{ width: `${secondsLeft === null ? 100 : (secondsLeft / (QR_STEP_MS / 1000)) * 100}%` }} />
        </div>
      </div>
      <p className="hidden text-sm print:block">O QR de entrada só aparece na tela do celular (ele muda a cada 30 segundos).</p>
    </div>
  );
}
