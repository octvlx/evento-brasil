"use client";

// Carrossel de destaques da home: rolagem nativa com encaixe (gestos no celular),
// botões voltar/avançar contínuos (do último volta ao primeiro) e avanço automático
// a cada 5 s, pausado com o mouse em cima, com foco dentro ou depois de qualquer
// interação, e desligado com prefers-reduced-motion. Os cards vêm prontos do
// servidor (children); aqui só se controla a rolagem.
import { Children, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

const AUTOPLAY_MS = 5000;
const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeReduced(cb: () => void) {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function EventCarousel({ label, children }: { label: string; children: ReactNode }) {
  const slides = Children.toArray(children);
  const trackRef = useRef<HTMLUListElement>(null);
  const id = useId();
  // No servidor: sem movimento até saber a preferência do navegador.
  const reducedMotion = useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED).matches, () => true);
  const [overflowing, setOverflowing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Interagiu (botão, gesto, teclado) ou apertou pausar: o automático para de vez.
  const [stopped, setStopped] = useState(false);
  const [current, setCurrent] = useState(0);
  const [announce, setAnnounce] = useState("");
  const pendingRef = useRef<number | null>(null);
  const pendingTimer = useRef<number | undefined>(undefined);

  const playing = overflowing && !reducedMotion && !stopped && !hovered && !focused;

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => setOverflowing(track.scrollWidth - track.clientWidth > 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    return () => ro.disconnect();
  }, [slides.length]);

  const step = useCallback(() => {
    const track = trackRef.current;
    const first = track?.firstElementChild as HTMLElement | null;
    if (!track || !first) return 0;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    return first.offsetWidth + gap;
  }, []);

  const move = useCallback(
    (dir: 1 | -1, manual: boolean) => {
      const track = trackRef.current;
      if (!track) return;
      const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
      const max = track.scrollWidth - track.clientWidth;
      // Cliques seguidos durante a rolagem suave partem do destino, não do meio do caminho.
      const from = pendingRef.current ?? track.scrollLeft;
      const s = step();
      let target = from + dir * s;
      if (dir === 1 && from >= max - 2) target = 0;
      else if (dir === -1 && from <= 2) target = max;
      target = Math.max(0, Math.min(max, target));
      pendingRef.current = target;
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = window.setTimeout(() => (pendingRef.current = null), 800);
      track.scrollTo({ left: target, behavior });
      if (manual) {
        const index = s ? Math.round(target / s) : 0;
        setAnnounce(`Evento ${Math.min(index + 1, slides.length)} de ${slides.length}`);
      }
    },
    [reducedMotion, slides.length, step],
  );

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") move(1, false);
    }, AUTOPLAY_MS);
    return () => window.clearInterval(t);
  }, [playing, move]);

  const onScroll = () => {
    const track = trackRef.current;
    const s = step();
    if (track && s) setCurrent(Math.round(track.scrollLeft / s));
  };

  if (!slides.length) return null;
  const manual = (dir: 1 | -1) => {
    setStopped(true);
    move(dir, true);
  };

  return (
    <div
      role="region"
      aria-roledescription="carrossel"
      aria-label={label}
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLElement && e.target.closest("input, select, textarea")) return;
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          manual(e.key === "ArrowRight" ? 1 : -1);
        }
      }}
    >
      <ul
        ref={trackRef}
        id={`${id}-trilho`}
        onScroll={onScroll}
        onScrollEnd={() => (pendingRef.current = null)}
        onPointerDown={() => setStopped(true)}
        onTouchStart={() => setStopped(true)}
        onWheel={(e) => Math.abs(e.deltaX) > Math.abs(e.deltaY) && setStopped(true)}
        className="scrollbar-none flex snap-x snap-mandatory gap-5 overflow-x-auto overscroll-x-contain pb-1"
        data-testid="carousel-track"
      >
        {slides.map((slide, i) => (
          <li
            key={i}
            aria-roledescription="slide"
            aria-label={`${i + 1} de ${slides.length}`}
            className="w-full shrink-0 snap-start md:w-[calc((100%-1.25rem)/2)] lg:w-[calc((100%-2.5rem)/3)] xl:w-[calc((100%-3.75rem)/4)]"
          >
            {slide}
          </li>
        ))}
      </ul>

      {/* Controles sobrepostos: aparecer/sumir não desloca o layout. */}
      <div className={cn("pointer-events-none absolute inset-x-0 top-[calc(50%-1.5rem)] flex -translate-y-1/2 justify-between px-1 sm:-mx-3", !overflowing && "hidden")}>
        <CarouselButton label="Evento anterior" controls={`${id}-trilho`} onClick={() => manual(-1)}>
          <ChevronLeft className="size-5" aria-hidden />
        </CarouselButton>
        <CarouselButton label="Próximo evento" controls={`${id}-trilho`} onClick={() => manual(1)}>
          <ChevronRight className="size-5" aria-hidden />
        </CarouselButton>
      </div>

      {/* Um card só nunca rola: sem a linha. Com vários, ela fica reservada (sem salto). */}
      {slides.length > 1 && (
        <div className={cn("mt-4 flex items-center justify-center gap-3", !overflowing && "invisible")} aria-hidden={!overflowing}>
          {!reducedMotion && (
            <button
              type="button"
              onClick={() => setStopped((s) => !s)}
              className="inline-flex size-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={stopped ? "Retomar passagem automática" : "Pausar passagem automática"}
              data-testid="carousel-toggle"
            >
              {stopped ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
            </button>
          )}
          <p className="text-xs font-semibold tabular-nums text-muted-foreground" data-testid="carousel-position">
            {Math.min(current + 1, slides.length)} / {slides.length}
          </p>
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

function CarouselButton({ label, controls, onClick, children }: { label: string; controls: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-controls={controls}
      onClick={onClick}
      className="pointer-events-auto inline-flex size-11 items-center justify-center rounded-full border border-border bg-card/95 text-foreground shadow-lg backdrop-blur transition hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}
