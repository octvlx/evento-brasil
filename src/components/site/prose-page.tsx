export function ProsePage({ title, notice, children }: { title: string; notice?: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">{title}</h1>
      {notice && <p className="mt-4 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">{notice}</p>}
      <div className="mt-6 space-y-4 text-[15px] leading-relaxed [&_h2]:mt-8 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_li]:ml-5 [&_li]:list-disc">{children}</div>
    </article>
  );
}
