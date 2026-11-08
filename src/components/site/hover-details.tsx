"use client";

import { useRef } from "react";

/**
 * <details> que também abre com o mouse em cima e recolhe ao sair (com uma pequena
 * folga para o mouse atravessar até o menu). Toque e teclado seguem o comportamento
 * nativo: tocar/Enter no resumo abre e fecha.
 */
export function HoverDetails({ className, children, closeDelayMs = 200 }: { className?: string; children: React.ReactNode; closeDelayMs?: number }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const pointer = useRef<string>("");
  const setOpen = (open: boolean) => {
    if (ref.current) ref.current.open = open;
  };
  return (
    <details
      ref={ref}
      className={className}
      onPointerEnter={(e) => {
        pointer.current = e.pointerType;
        if (e.pointerType !== "mouse") return;
        window.clearTimeout(timer.current);
        setOpen(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "mouse") return;
        timer.current = window.setTimeout(() => setOpen(false), closeDelayMs);
      }}
      onPointerDown={(e) => {
        pointer.current = e.pointerType;
      }}
      onClick={(e) => {
        // Com o mouse o menu já abriu ao passar por cima: o clique no resumo não o fecha.
        const onSummary = (e.target as Element).closest("summary");
        if (onSummary && e.detail > 0 && pointer.current === "mouse") {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      {children}
    </details>
  );
}
