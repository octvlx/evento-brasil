"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { ArrowLeftRight, Camera, CameraOff, IdCard, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { CheckinResponse } from "@/server/services/checkin";
import { checkInAction } from "./actions";

const RESULT_STYLE: Record<string, string> = {
  ADMITTED: "bg-emerald-600",
  DUPLICATE: "bg-amber-500",
  WRONG_EVENT: "bg-rose-600",
  REVOKED: "bg-rose-600",
  INVALID: "bg-rose-600",
  EVENT_NOT_ACTIVE: "bg-zinc-700",
};

/** Meia-entrada admitida (ou já utilizada): a portaria precisa conferir o documento comprobatório. */
function needsHalfPriceDocument(r: CheckinResponse) {
  return (r.result === "ADMITTED" || r.result === "DUPLICATE") && r.ticket?.ticketKind === "HALF_PRICE";
}

export function Scanner({ eventId, initialCounters }: { eventId: string; initialCounters: { admitted: number; total: number } }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const busy = useRef(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [counters, setCounters] = useState(initialCounters);
  const [manual, setManual] = useState("");

  const submit = useCallback(
    async (payload: string) => {
      if (busy.current) return;
      busy.current = true;
      // Meia-entrada fica mais tempo na tela: dá tempo de pedir e conferir o documento.
      let holdMs = 1500;
      try {
        const r = await checkInAction(eventId, payload);
        if (r.ok) {
          setResult(r.data);
          setCounters(r.data.counters);
          setError(null);
          if (needsHalfPriceDocument(r.data)) holdMs = 2200;
          navigator.vibrate?.(r.data.result === "ADMITTED" ? 80 : [60, 60, 60, 60, 200]);
        } else setError(r.error);
      } catch {
        // Falha de rede ou do servidor: avisa e libera o leitor (sem nova tentativa automática).
        setError("Não foi possível validar o ingresso. Verifique a conexão e leia o QR novamente.");
        navigator.vibrate?.([60, 60, 60, 60, 200]);
      } finally {
        setTimeout(() => {
          setResult(null);
          busy.current = false;
          router.refresh();
        }, holdMs);
      }
    },
    [eventId, router],
  );

  useEffect(() => {
    if (!cameraOn) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let last = 0;
    // A limpeza pode rodar antes de a câmera abrir (desligar ou sair da página durante
    // getUserMedia/play): sem esta marca o laço começaria depois, com os refs já nulos.
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        stream = s;
        const video = videoRef.current;
        if (cancelled || !video) return stop();
        video.srcObject = s;
        await video.play();
        if (cancelled) return stop();
        const tick = (t: number) => {
          const canvas = canvasRef.current;
          if (cancelled || !canvas || !videoRef.current) return;
          raf = requestAnimationFrame(tick);
          if (t - last < 200 || busy.current || video.readyState < 2 || !video.videoWidth) return;
          last = t;
          const w = Math.min(640, video.videoWidth);
          const h = Math.round((video.videoHeight / video.videoWidth) * w);
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(video, 0, 0, w, h);
          const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
          if (code?.data) submit(code.data);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        if (cancelled) return stop();
        setCameraError("Não foi possível acessar a câmera. Verifique a permissão do navegador ou use a digitação manual.");
        setCameraOn(false);
      }
    })();
    return stop;
  }, [cameraOn, submit]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-muted p-4 text-center">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Entradas</p>
          <p className="font-display text-3xl font-extrabold tabular-nums">{counters.admitted}</p>
        </div>
        <div className="rounded-2xl bg-muted p-4 text-center">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Ingressos válidos</p>
          <p className="font-display text-3xl font-extrabold tabular-nums">{counters.total}</p>
        </div>
      </div>

      <div className="relative aspect-square overflow-hidden rounded-3xl bg-black">
        <video ref={videoRef} className={cn("h-full w-full object-cover", !cameraOn && "hidden")} muted playsInline />
        <canvas ref={canvasRef} className="hidden" />
        {!cameraOn && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-white/80">
            <div>
              <Camera className="mx-auto size-10" aria-hidden />
              <p className="mt-2 text-sm">Toque em “Ativar câmera” e aponte para o QR code do ingresso.</p>
            </div>
          </div>
        )}
        {cameraOn && <div className="pointer-events-none absolute inset-[18%] rounded-3xl border-4 border-white/70" aria-hidden />}
        {result && (
          <div className={cn("absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-white", RESULT_STYLE[result.result])} role="alert" aria-live="assertive">
            <p className="font-display text-3xl font-extrabold">{result.message}</p>
            {result.ticket && (
              <>
                {result.ticket.transferred ? (
                  // Só chega para a portaria da organização do evento (checkInTicket não devolve
                  // dados de ingresso de outra organização).
                  <p className="mt-3 flex items-center gap-2 rounded-2xl bg-black/25 px-4 py-2 text-left text-base font-semibold">
                    <ArrowLeftRight className="size-5 shrink-0" aria-hidden />
                    <span>
                      Ingresso transferido — titular atual: <strong className="text-lg">{result.ticket.holderName ?? "—"}</strong>
                    </span>
                  </p>
                ) : (
                  <p className="mt-3 text-lg font-semibold">{result.ticket.holderName}</p>
                )}
                {result.ticket.qrReplaced && <p className="mt-2 text-sm">Este QR foi substituído na transferência. Peça ao titular atual o QR novo.</p>}
                <p className="text-sm opacity-90">
                  {result.ticket.ticketTypeName} · {result.ticket.code}
                </p>
                {result.result === "DUPLICATE" && result.ticket.checkedInAt && (
                  <p className="mt-2 text-sm">Entrada registrada às {new Date(result.ticket.checkedInAt).toLocaleTimeString("pt-BR")}</p>
                )}
                {needsHalfPriceDocument(result) && (
                  <p className="mt-4 flex items-center gap-3 rounded-2xl border-4 border-yellow-300 bg-black px-4 py-3 text-left text-lg font-extrabold uppercase leading-tight text-yellow-300">
                    <IdCard className="size-8 shrink-0" aria-hidden />
                    Meia-entrada — exigir documento comprobatório
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <Button size="lg" variant={cameraOn ? "outline" : "secondary"} className="w-full" onClick={() => setCameraOn((v) => !v)}>
        {cameraOn ? <CameraOff aria-hidden /> : <Camera aria-hidden />} {cameraOn ? "Desativar câmera" : "Ativar câmera"}
      </Button>
      {cameraError && <p className="text-sm text-destructive">{cameraError}</p>}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) submit(manual.trim());
          setManual("");
        }}
      >
        <label className="sr-only" htmlFor="manual">
          Conteúdo do QR code
        </label>
        <Input id="manual" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Colar conteúdo do QR (EB1:…)" autoComplete="off" />
        <Button type="submit" variant="outline">
          <Keyboard aria-hidden /> Validar
        </Button>
      </form>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
