import Link from "next/link";
import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-8", className)}>
      <defs>
        <linearGradient id="eb-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#f43f5e" />
        </linearGradient>
      </defs>
      {/* Ingresso com picote, formando um "e" estilizado */}
      <path
        d="M6 6h20a2 2 0 0 1 2 2v4a4 4 0 0 0 0 8v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4a4 4 0 0 0 0-8V8a2 2 0 0 1 2-2Z"
        fill="url(#eb-g)"
      />
      <path d="M11 16h10M11 11.5h10M11 20.5h6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** `wordmarkClassName`: classes do texto "eventobrasil" (o header o esconde em telas muito estreitas). */
export function Logo({ className, inverted, wordmarkClassName }: { className?: string; inverted?: boolean; wordmarkClassName?: string }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2 font-display text-lg font-extrabold tracking-tight", className)} aria-label="Evento Brasil — início">
      <LogoMark />
      <span className={cn(inverted && "text-white", wordmarkClassName)}>
        evento<span className="text-accent">brasil</span>
      </span>
    </Link>
  );
}
