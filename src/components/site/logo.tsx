import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * Símbolo QQPega: dois "Q" entrelaçados (limão e pink) sobre a tinta da marca —
 * duas pessoas, dois rolês, conexão. O mesmo desenho vira o favicon (src/app/icon.svg).
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-8 shrink-0", className)}>
      <rect width="32" height="32" rx="9" fill="#16121f" />
      <circle cx="12.25" cy="15.25" r="5.25" fill="none" stroke="#c6f432" strokeWidth="3" />
      <circle cx="20" cy="15.25" r="5.25" fill="none" stroke="#ff4f93" strokeWidth="3" />
      <path d="M23.4 18.65 26.2 21.45" stroke="#ff4f93" strokeWidth="3" strokeLinecap="round" />
      {/* Entrelaçado: o limão passa por cima do pink na interseção de cima. */}
      <path d="M14.88 10.7A5.25 5.25 0 0 1 17.01 13.03" fill="none" stroke="#c6f432" strokeWidth="3" />
      {/* Rabinho do primeiro Q "pegando" o segundo anel. */}
      <path d="M15.65 18.65 18.3 21.3" stroke="#c6f432" strokeWidth="3" strokeLinecap="round" />
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

/** "QQPega" com o "QQ" em destaque; capitalização oficial preservada. */
export function Wordmark({ inverted, className }: { inverted?: boolean; className?: string }) {
  return (
    <span className={cn("tracking-[-0.04em]", inverted ? "text-white" : "text-foreground", className)}>
      <span className={inverted ? "text-lime" : "text-secondary"}>QQ</span>Pega
    </span>
  );
}
