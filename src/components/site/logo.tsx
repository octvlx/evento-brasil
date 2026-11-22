import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * Símbolo TICKET24: um ingresso limão com picote nas laterais e o "24" na tinta da
 * marca. O mesmo desenho vira o favicon e os ícones (src/app/icon.svg, public/icons).
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-8 shrink-0", className)}>
      <rect width="32" height="32" rx="9" fill="#16121f" />
      <rect x="4" y="8" width="24" height="16" rx="3" fill="#c6f432" />
      {/* Picote: meia-lua recortada em cada lateral do ingresso. */}
      <circle cx="4" cy="16" r="2.6" fill="#16121f" />
      <circle cx="28" cy="16" r="2.6" fill="#16121f" />
      <g fill="none" stroke="#16121f" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.9 13.7a2.65 2.65 0 0 1 5.3 0c0 1.5-1.1 2.4-2.4 3.5L9.9 20h5.4" />
        <path d="M21.4 20.3V11.4l-4.3 6.2h6.1" />
      </g>
    </svg>
  );
}

/** Logotipo tipográfico. `inverted`: sobre fundo escuro. `wordmarkClassName`: o header esconde o texto em telas muito estreitas. */
export function Logo({ className, inverted, wordmarkClassName }: { className?: string; inverted?: boolean; wordmarkClassName?: string }) {
  return (
    <Link
      href="/"
      className={cn("flex items-center gap-2 rounded-xl font-display text-lg font-extrabold leading-none", className)}
      aria-label={`${BRAND.name} — início`}
    >
      <LogoMark />
      <Wordmark inverted={inverted} className={wordmarkClassName} />
    </Link>
  );
}

/** "TICKET24" com o "24" em destaque; sempre em maiúsculas. */
export function Wordmark({ inverted, className }: { inverted?: boolean; className?: string }) {
  return (
    <span className={cn("tracking-[-0.04em]", inverted ? "text-white" : "text-foreground", className)}>
      TICKET<span className={inverted ? "text-lime" : "text-secondary"}>24</span>
    </span>
  );
}
