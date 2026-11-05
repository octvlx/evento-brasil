import { LogoMark, Wordmark } from "./logo";

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="mx-auto grid max-w-5xl gap-10 px-4 py-10 sm:px-6 md:grid-cols-2 md:py-16">
      <div className="bg-hero relative hidden overflow-hidden rounded-3xl p-10 text-white md:flex md:flex-col md:justify-between">
        <div className="bg-dots pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative flex items-center gap-2.5 font-display text-xl font-extrabold">
          <LogoMark className="size-10" />
          <Wordmark inverted />
        </div>
        <div className="relative">
          <p className="font-display text-3xl font-extrabold leading-tight">
            Seu próximo evento <span className="text-lime">começa aqui.</span>
          </p>
          <p className="mt-3 text-white/80">Ingresso no celular, PIX na hora e o que está rolando na sua cidade.</p>
        </div>
      </div>
      <div className="flex flex-col justify-center">
        <h1 className="font-display text-2xl font-extrabold sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-muted-foreground">{subtitle}</p>}
        <div className="mt-6">{children}</div>
        {footer && <div className="mt-6 text-sm text-muted-foreground">{footer}</div>}
      </div>
    </div>
  );
}
