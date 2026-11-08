import Link from "next/link";
import { Suspense } from "react";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { PanelNavLinks } from "./panel-nav";

export function PanelShell({
  title,
  nav,
  aside,
  children,
  collapsible,
}: {
  title: string;
  nav: [string, string][];
  aside?: React.ReactNode;
  children: React.ReactNode;
  /** A partir de tablets (md): menu recolhido numa faixa estreita; abre com o mouse em cima ou com foco pelo teclado. */
  collapsible?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6",
        collapsible ? "md:grid-cols-[44px_1fr]" : "lg:grid-cols-[220px_1fr]",
      )}
    >
      <aside
        className={cn(
          collapsible ? "group/menu relative md:sticky md:top-20 md:z-30 md:self-start" : "lg:sticky lg:top-20 lg:self-start",
        )}
      >
        {collapsible && (
          <button
            type="button"
            aria-label={`Abrir menu: ${title}`}
            className="hidden size-11 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground shadow-card transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:flex"
          >
            <Menu className="size-5" aria-hidden />
          </button>
        )}
        <div
          className={cn(
            collapsible &&
              "md:pointer-events-none md:absolute md:left-0 md:top-0 md:w-60 md:-translate-x-2 md:rounded-2xl md:border md:border-border md:bg-card md:p-2 md:opacity-0 md:shadow-lift md:transition md:duration-150 md:group-has-[:focus-visible]/menu:pointer-events-auto md:group-has-[:focus-visible]/menu:translate-x-0 md:group-has-[:focus-visible]/menu:opacity-100 md:group-hover/menu:pointer-events-auto md:group-hover/menu:translate-x-0 md:group-hover/menu:opacity-100 motion-reduce:md:transition-none md:[&_nav]:mx-0 md:[&_nav]:flex-col md:[&_nav]:px-0",
          )}
        >
          <p className="mb-2 px-3 text-xs font-bold uppercase tracking-widest text-secondary">
            {title}
          </p>
          {aside}
          {nav.length > 0 && (
            // usePathname é dado de runtime: Suspense com Cache Components (o fallback é o mesmo menu, sem destaque).
            <Suspense fallback={<StaticNav nav={nav} />}>
              <PanelNavLinks items={nav} root={nav[0][0]} />
            </Suspense>
          )}
        </div>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function StaticNav({ nav }: { nav: [string, string][] }) {
  return (
    <nav
      aria-label="Menu do painel"
      className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0"
    >
      {nav.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className="shrink-0 rounded-xl px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function PageTitle({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-extrabold sm:text-3xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-card">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-2xl font-extrabold tracking-tight tabular-nums">
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
