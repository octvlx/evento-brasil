import Link from "next/link";
import { CANCEL_HELP_HREF } from "@/lib/help-links";
import { BRAND } from "@/lib/brand";
import { Logo } from "./logo";

export function SiteFooter() {
  return (
    <footer className="mt-20 print:hidden bg-night pb-24 text-white md:pb-0">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-4">
        <div className="space-y-3">
          <Logo inverted />
          <p className="max-w-xs text-sm text-white/70">{BRAND.tagline}. Achou o rolê? É só pegar o ingresso.</p>
        </div>
        <FooterCol
          title="Para você"
          links={[
            ["/eventos", "Explorar eventos"],
            ["/meus-ingressos", "Meus ingressos"],
            [CANCEL_HELP_HREF, "Cancelar compra / arrependimento"],
            ["/ajuda", "Central de ajuda"],
          ]}
        />
        <FooterCol
          title="Para organizadores"
          links={[
            ["/organizador/cadastro", "Venda ingressos"],
            ["/organizador", "Painel do organizador"],
            ["/ajuda#taxas", "Taxas e repasses"],
          ]}
        />
        <FooterCol
          title="Institucional"
          links={[
            ["/termos", "Termos de uso"],
            ["/privacidade", "Privacidade (LGPD)"],
            ["/ajuda#contato", "Atendimento ao cliente"],
          ]}
        />
      </div>
      <div className="border-t border-white/10">
        <p className="mx-auto max-w-7xl px-4 py-5 text-xs text-white/60 sm:px-6">
          © {BRAND.name}. Ambiente de desenvolvimento — eventos e pagamentos exibidos são fictícios.
        </p>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-lime">{title}</h2>
      <ul className="space-y-2">
        {links.map(([href, label]) => (
          <li key={href}>
            <Link href={href} className="rounded text-sm text-white/75 hover:text-white focus-visible:outline-lime">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
