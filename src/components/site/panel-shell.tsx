import Link from "next/link";

export function PanelShell({ title, nav, aside, children }: { title: string; nav: [string, string][]; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[220px_1fr]">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <p className="mb-2 px-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">{title}</p>
        {aside}
        <nav className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
          {nav.map(([href, label]) => (
            <Link key={href} href={href} className="shrink-0 rounded-xl px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl font-extrabold tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-extrabold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
