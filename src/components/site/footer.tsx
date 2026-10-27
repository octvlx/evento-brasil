import Link from "next/link";
import { CANCEL_HELP_HREF } from "@/lib/help-links";
import { Logo } from "./logo";

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-border bg-muted/40 pb-24 md:pb-0">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-4">
        <div className="space-y-3">
          <Logo />
          <p className="text-sm text-muted-foreground">Descubra, compre e viva os melhores eventos do Brasil.</p>
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
      <div className="border-t border-border">
        <p className="mx-auto max-w-7xl px-4 py-5 text-xs text-muted-foreground sm:px-6">
          © Evento Brasil (nome provisório). Ambiente de desenvolvimento — eventos e pagamentos exibidos são fictícios.
        </p>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-bold">{title}</h2>
      <ul className="space-y-2">
        {links.map(([href, label]) => (
          <li key={href}>
            <Link href={href} className="text-sm text-muted-foreground hover:text-foreground">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
