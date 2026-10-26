import { LogoMark } from "./logo";

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="mx-auto grid max-w-5xl gap-10 px-4 py-10 sm:px-6 md:grid-cols-2 md:py-16">
      <div className="bg-hero hidden rounded-3xl p-10 text-white md:flex md:flex-col md:justify-between">
        <LogoMark className="size-12" />
        <div>
          <p className="font-display text-3xl font-extrabold leading-tight">Seu próximo rolê começa aqui.</p>
          <p className="mt-3 text-white/80">Ingressos no celular, PIX na hora e eventos em todo o Brasil.</p>
        </div>
      </div>
      <div className="flex flex-col justify-center">
        <h1 className="font-display text-3xl font-extrabold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-muted-foreground">{subtitle}</p>}
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 text-sm text-muted-foreground">{footer}</div>}
      </div>
    </div>
  );
}
