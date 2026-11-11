"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import jsQR from "jsqr";
import { ArrowLeftRight, Camera, CameraOff, CloudDownload, CloudUpload, Flashlight, FlashlightOff, IdCard, Keyboard, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { parseQrPayload } from "@/lib/qr-payload";
import type { CheckinResult } from "@/generated/prisma/browser";
import type { CheckinResponse, OfflinePackage, OfflineSyncItem } from "@/server/services/checkin";
import { checkInAction, offlinePackageAction, syncOfflineAction } from "./actions";
import { forgetOfflineEvent, offlineStore, prepareOfflineShell, tokenHash, type QueuedEntry } from "./offline-store";

const RESULT_STYLE: Record<string, string> = {
  ADMITTED: "bg-emerald-600",
  DUPLICATE: "bg-amber-500",
  WRONG_EVENT: "bg-rose-600",
  REVOKED: "bg-rose-600",
  INVALID: "bg-rose-600",
  EVENT_NOT_ACTIVE: "bg-zinc-700",
};

const OFFLINE_MESSAGES: Record<CheckinResult, string> = {
  ADMITTED: "Entrada liberada (offline)",
  DUPLICATE: "JÁ UTILIZADO neste aparelho",
  WRONG_EVENT: "Ingresso de OUTRO evento",
  REVOKED: "Ingresso CANCELADO/REEMBOLSADO",
  INVALID: "QR fora da lista baixada",
  EVENT_NOT_ACTIVE: "Lista offline vencida",
};

type Shown = CheckinResponse & { offline?: boolean };

/** Meia-entrada admitida (ou já utilizada): a portaria precisa conferir o documento comprobatório. */
function needsHalfPriceDocument(r: CheckinResponse) {
  return (r.result === "ADMITTED" || r.result === "DUPLICATE") && r.ticket?.ticketKind === "HALF_PRICE";
}

// Conexão do navegador (eventos online/offline), lida sem estado próprio.
const subscribeOnline = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};
const isExpired = (p: OfflinePackage | null) => (p ? new Date(p.validUntil).getTime() < Date.now() : false);

/** Falha de rede (sem resposta do servidor), diferente de uma recusa do servidor. */
const isNetworkError = (e: unknown) => e instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine);

export function Scanner({ eventId, initialCounters }: { eventId: string; initialCounters: { admitted: number; total: number } }) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const busy = useRef(false);
  const syncing = useRef(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [result, setResult] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [counters, setCounters] = useState(initialCounters);
  const [manual, setManual] = useState("");

  // Check-in offline
  const browserOnline = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  // Servidor sem resposta com o navegador "online" (rede ruim): tratado como offline até a próxima leitura online.
  const [unreachable, setUnreachable] = useState(false);
  const online = browserOnline && !unreachable;
  const [pkg, setPkgState] = useState<OfflinePackage | null>(null);
  const [pkgExpired, setPkgExpired] = useState(false);
  const setPkg = (p: OfflinePackage | null) => {
    setPkgState(p);
    setPkgExpired(isExpired(p));
  };
  const [queue, setQueue] = useState<QueuedEntry[]>([]);
  const [offlineMsg, setOfflineMsg] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<OfflineSyncItem[] | null>(null);
  const [storeOk, setStoreOk] = useState(true);
  const pkgRef = useRef<OfflinePackage | null>(null);
  useEffect(() => {
    pkgRef.current = pkg;
  }, [pkg]);
  const [offlineBusy, setOfflineBusy] = useState(false);


  /**
   * A conta perdeu o acesso ao check-in deste evento (ou ele não existe mais): apaga a
   * lista, a fila e a cópia do leitor deste evento no aparelho. A fila não poderia mais ser
   * enviada por esta conta.
   */
  const lostAccess = useCallback(
    async (r: { code?: string }) => {
      if (r.code !== "FORBIDDEN" && r.code !== "NOT_FOUND") return false;
      await forgetOfflineEvent(eventId);
      setPkgState(null);
      setQueue([]);
      setOfflineMsg("Sua conta não tem mais acesso ao check-in deste evento: a lista offline foi apagada deste aparelho.");
      return true;
    },
    [eventId],
  );

  /** Envia a fila; o servidor valida cada leitura como no online. */
  const sync = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    setOfflineBusy(true);
    try {
      const pending = await offlineStore.getQueue(eventId);
      if (!pending.length) return;
      const r = await syncOfflineAction(eventId, pending.slice(0, 500));
      if (!r.ok) {
        if (!(await lostAccess(r))) setOfflineMsg(r.error);
        return;
      }
      // Remove da fila só o que foi enviado (leituras novas feitas durante o envio ficam).
      const rest = (await offlineStore.getQueue(eventId)).slice(Math.min(pending.length, 500));
      await offlineStore.setQueue(eventId, rest);
      setQueue(rest);
      setCounters(r.data.counters);
      setSyncResult(r.data.items);
      const diverged = r.data.items.filter((i) => i.divergence).length;
      setOfflineMsg(`${r.data.items.length} ${r.data.items.length === 1 ? "leitura enviada" : "leituras enviadas"}${diverged ? ` · ${diverged} com divergência: confira abaixo` : ""}.`);
      router.refresh();
    } catch (e) {
      setOfflineMsg(isNetworkError(e) ? "Sem internet: as leituras continuam guardadas e serão enviadas quando a conexão voltar." : "Não foi possível enviar as leituras agora.");
    } finally {
      syncing.current = false;
      setOfflineBusy(false);
    }
  }, [eventId, lostAccess, router]);

  // Carrega a lista e a fila guardadas; com internet, já envia o que ficou pendente.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [p, q] = await Promise.all([offlineStore.getPackage(eventId), offlineStore.getQueue(eventId)]);
        if (!alive) return;
        setPkgState(p ?? null);
        setPkgExpired(isExpired(p ?? null));
        setQueue(q);
        // Lista já baixada: mantém o leitor pronto para abrir sem internet (atualiza a cópia).
        if (p && navigator.onLine) void prepareOfflineShell();
        if (navigator.onLine && q.length) void sync();
      } catch {
        if (alive) setStoreOk(false);
      }
    })();
    // A lista vence com o tempo: confere a cada minuto.
    const timer = window.setInterval(() => setPkgExpired(isExpired(pkgRef.current)), 60_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [eventId, sync]);

  // Conexão de volta: envia a fila.
  useEffect(() => {
    const up = () => {
      setUnreachable(false);
      void sync();
    };
    window.addEventListener("online", up);
    return () => window.removeEventListener("online", up);
  }, [sync]);

  const download = async () => {
    setOfflineBusy(true);
    setOfflineMsg(null);
    try {
      const r = await offlinePackageAction(eventId);
      if (!r.ok) {
        if (!(await lostAccess(r))) setOfflineMsg(r.error);
        return;
      }
      await offlineStore.setPackage(eventId, r.data);
      // Lista nova: o que já entrou vem marcado nela; zera só o "usado neste aparelho".
      await offlineStore.setUsed(eventId, new Set());
      setPkg(r.data);
      const shell = await prepareOfflineShell();
      setOfflineMsg(
        `Lista baixada: ${r.data.tickets.length} ingressos. Se a internet cair, o leitor continua validando com ela${shell ? " e pode ser aberto de novo sem internet neste aparelho" : ""}.`,
      );
    } catch (e) {
      setOfflineMsg(isNetworkError(e) ? "Sem internet: baixe a lista quando estiver conectado." : "Não foi possível baixar a lista.");
    } finally {
      setOfflineBusy(false);
    }
  };

  /** Validação no aparelho, contra a lista baixada e o que este aparelho já liberou. */
  const checkOffline = useCallback(
    async (payload: string): Promise<Shown> => {
      const current = pkg ?? (await offlineStore.getPackage(eventId)) ?? null;
      const show = (r: CheckinResult, t?: OfflinePackage["tickets"][number], checkedInAt: Date | null = null): Shown => ({
        result: r,
        message: OFFLINE_MESSAGES[r],
        offline: true,
        ticket: t && { code: t.code, holderName: t.holderName, ticketTypeName: t.ticketTypeName, ticketKind: t.ticketKind, checkedInAt, transferred: false },
        counters,
      });
      if (!current || new Date(current.validUntil).getTime() < Date.now()) return show("EVENT_NOT_ACTIVE");
      const parsed = parseQrPayload(payload);
      const hash = parsed ? await tokenHash(parsed.token) : null;
      const t = hash ? current.tickets.find((x) => x.h === hash && x.code === parsed!.code) : undefined;
      let r: CheckinResult;
      const used = await offlineStore.getUsed(eventId);
      if (!t) r = "INVALID";
      else if (t.status === "REVOKED") r = "REVOKED";
      else if (t.status === "CHECKED_IN" || used.has(t.h)) r = "DUPLICATE";
      else {
        r = "ADMITTED";
        used.add(t.h);
        await offlineStore.setUsed(eventId, used);
      }
      // Toda leitura vai para a fila (o servidor registra e decide, inclusive as recusadas).
      const next = [...(await offlineStore.getQueue(eventId)), { payload: payload.slice(0, 200), scannedAt: new Date().toISOString(), localResult: r }];
      await offlineStore.setQueue(eventId, next);
      setQueue(next);
      if (r === "ADMITTED") setCounters((c) => ({ ...c, admitted: c.admitted + 1 }));
      return show(r, t, r === "ADMITTED" ? new Date() : null);
    },
    [counters, eventId, pkg],
  );

  const submit = useCallback(
    async (payload: string) => {
      if (busy.current) return;
      busy.current = true;
      // Meia-entrada fica mais tempo na tela: dá tempo de pedir e conferir o documento.
      let holdMs = 1500;
      const display = (r: Shown) => {
        setResult(r);
        setError(null);
        if (needsHalfPriceDocument(r)) holdMs = 2200;
        navigator.vibrate?.(r.result === "ADMITTED" ? 80 : [60, 60, 60, 60, 200]);
      };
      try {
        if (!navigator.onLine && pkg) {
          display(await checkOffline(payload));
          return;
        }
        const r = await checkInAction(eventId, payload);
        setUnreachable(false);
        if (r.ok) {
          setCounters(r.data.counters);
          display(r.data);
          // Liberado online: marca neste aparelho, para a lista offline já saber.
          const parsed = r.data.result === "ADMITTED" ? parseQrPayload(payload) : null;
          if (parsed && storeOk && pkg) {
            const used = await offlineStore.getUsed(eventId);
            used.add(await tokenHash(parsed.token));
            await offlineStore.setUsed(eventId, used);
          }
        } else {
          setError(r.error);
          void lostAccess(r);
        }
      } catch (e) {
        // Sem resposta do servidor: com lista baixada, valida no aparelho; sem lista, avisa.
        if (isNetworkError(e) && pkg) {
          setUnreachable(true);
          display(await checkOffline(payload));
        } else {
          setError("Não foi possível validar o ingresso. Verifique a conexão e leia o QR novamente.");
          navigator.vibrate?.([60, 60, 60, 60, 200]);
        }
      } finally {
        setTimeout(() => {
          setResult(null);
          busy.current = false;
          if (navigator.onLine) router.refresh();
        }, holdMs);
      }
    },
    [checkOffline, eventId, lostAccess, pkg, router, storeOk],
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
      trackRef.current = null;
      setTorchSupported(false);
      setTorchOn(false);
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
        // Lanterna: só quando a câmera informa suporte (Chrome no Android; não existe no iPhone).
        const track = s.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
        setTorchSupported(caps.torch === true);
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

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
      setCameraError("Não foi possível acender a lanterna neste aparelho.");
    }
  };

  const conflicts = syncResult?.filter((i) => i.divergence === "ADMITTED_BUT_REJECTED") ?? [];
  const refusedValid = syncResult?.filter((i) => i.divergence === "REFUSED_BUT_VALID") ?? [];

  return (
    <div className="space-y-4">
      {!online && (
        <Alert variant="warning" role="status" className="flex items-start gap-2">
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {pkg && !pkgExpired
              ? "Sem internet: validando com a lista baixada. As leituras ficam guardadas e são enviadas quando a conexão voltar."
              : "Sem internet e sem lista offline válida: não é possível validar até a conexão voltar."}
          </span>
        </Alert>
      )}

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
        {cameraOn && torchSupported && !result && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-pressed={torchOn}
            aria-label={torchOn ? "Apagar lanterna" : "Acender lanterna"}
            className={cn(
              "absolute right-3 top-3 grid size-12 place-items-center rounded-full shadow-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70",
              torchOn ? "bg-yellow-300 text-black" : "bg-black/60 text-white",
            )}
          >
            {torchOn ? <Flashlight className="size-6" aria-hidden /> : <FlashlightOff className="size-6" aria-hidden />}
          </button>
        )}
        {result && (
          <div className={cn("absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-white", RESULT_STYLE[result.result])} role="alert" aria-live="assertive">
            <p className="font-display text-3xl font-extrabold">{result.message}</p>
            {result.offline && <p className="mt-1 rounded-full bg-black/25 px-3 py-0.5 text-xs font-bold uppercase">Sem internet · será confirmado ao sincronizar</p>}
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

      <div className={cn("grid gap-2", cameraOn && torchSupported ? "grid-cols-[1fr_auto]" : "grid-cols-1")}>
        <Button size="lg" variant={cameraOn ? "outline" : "secondary"} className="w-full" onClick={() => setCameraOn((v) => !v)}>
          {cameraOn ? <CameraOff aria-hidden /> : <Camera aria-hidden />} {cameraOn ? "Desativar câmera" : "Ativar câmera"}
        </Button>
        {cameraOn && torchSupported && (
          <Button size="lg" variant={torchOn ? "accent" : "outline"} aria-pressed={torchOn} onClick={toggleTorch}>
            {torchOn ? <Flashlight aria-hidden /> : <FlashlightOff aria-hidden />} {torchOn ? "Apagar lanterna" : "Lanterna"}
          </Button>
        )}
      </div>
      {cameraOn && !torchSupported && <p className="text-xs text-muted-foreground">Este aparelho ou navegador não permite acender a lanterna pela página.</p>}
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

      <section aria-labelledby="modo-offline" className="space-y-2 rounded-2xl border border-border bg-card p-4 text-sm">
        <h2 id="modo-offline" className="font-bold">
          Check-in sem internet
        </h2>
        {!storeOk ? (
          <p className="text-muted-foreground">Este navegador não permite guardar dados (modo privado?): o modo offline não está disponível.</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              {pkg
                ? `Lista baixada às ${new Date(pkg.generatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} com ${pkg.tickets.length} ingressos${pkgExpired ? " — vencida, baixe de novo" : `, válida até ${new Date(pkg.validUntil).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`}.`
                : "Baixe a lista antes de abrir os portões: se a internet cair, o leitor continua validando neste aparelho."}
            </p>
            <p className="text-xs text-muted-foreground">
              Sem internet, cada aparelho só conhece as próprias leituras: um ingresso pode passar em dois aparelhos. Use um aparelho por entrada. Com a lista baixada, o leitor abre mesmo sem internet neste navegador; ao sair da conta, a lista e a cópia do leitor são apagadas do aparelho.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={offlineBusy || !online} onClick={download}>
                <CloudDownload aria-hidden /> {pkg ? "Atualizar lista" : "Baixar lista para uso offline"}
              </Button>
              {queue.length > 0 && (
                <Button type="button" size="sm" variant="secondary" disabled={offlineBusy || !online} onClick={() => void sync()}>
                  <CloudUpload aria-hidden /> Enviar {queue.length} {queue.length === 1 ? "leitura pendente" : "leituras pendentes"}
                </Button>
              )}
            </div>
            {queue.length > 0 && !online && <p className="font-semibold">{queue.length === 1 ? "1 leitura guardada" : `${queue.length} leituras guardadas`} para enviar.</p>}
            {offlineMsg && (
              <p role="status" className="font-medium">
                {offlineMsg}
              </p>
            )}
            {conflicts.length > 0 && (
              <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
                <p className="font-semibold text-destructive">Liberados sem internet, mas recusados pelo servidor:</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {conflicts.map((c, i) => (
                    <li key={`${c.payload}-${i}`}>
                      <strong>{c.holderName ?? c.code ?? "Ingresso"}</strong>
                      {c.code ? ` (${c.code})` : ""}: {c.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {refusedValid.length > 0 && (
              <div role="alert" className="rounded-xl border border-warning/40 bg-warning-soft p-3">
                <p className="font-semibold">Recusados sem internet, mas com ingresso válido (continuam sem entrada):</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {refusedValid.map((c, i) => (
                    <li key={`${c.payload}-${i}`}>
                      <strong>{c.holderName ?? c.code ?? "Ingresso"}</strong>
                      {c.code ? ` (${c.code})` : ""}: se a pessoa voltar, leia o QR de novo com internet.
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
