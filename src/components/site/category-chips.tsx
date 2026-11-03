import Link from "next/link";
import { cn } from "@/lib/utils";

export function CategoryChips({
  categories,
  active,
  hrefFor,
  tone = "default",
  compact = false,
}: {
  categories: { slug: string; name: string }[];
  active?: string;
  hrefFor: (slug?: string) => string;
  tone?: "default" | "hero";
  /** Uma linha só (rolagem lateral) e chips menores: a busca compacta da home. */
  compact?: boolean;
}) {
  const base = cn("shrink-0 rounded-full font-semibold transition", compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm");
  const styles =
    tone === "hero"
      ? { on: "bg-white text-primary", off: "bg-white/10 text-white hover:bg-white/20 ring-1 ring-white/20" }
      : { on: "bg-secondary text-secondary-foreground", off: "bg-muted text-foreground hover:bg-border" };
  return (
    <nav aria-label="Categorias" className={cn("scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0", !compact && "sm:flex-wrap")}>
      <Link href={hrefFor()} className={cn(base, !active ? styles.on : styles.off)} aria-current={!active ? "page" : undefined}>
        Todos
      </Link>
      {categories.map((c) => (
        <Link key={c.slug} href={hrefFor(c.slug)} className={cn(base, active === c.slug ? styles.on : styles.off)} aria-current={active === c.slug ? "page" : undefined}>
          {c.name}
        </Link>
      ))}
    </nav>
  );
}
