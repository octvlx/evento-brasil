// Amostras locais no formato das páginas públicas da Duoticket (estrutura, não conteúdo:
// textos fictícios escritos para os testes). Nenhum teste acessa sites externos.

export function duoListingHtml(items: { id: string; slug: string; absolute?: boolean }[], extra = "") {
  const cards = items
    .map(
      (i) => `<div class="card"><a href="${i.absolute ? "https://duoticket.com.br/" : ""}evento/${i.id}/${i.slug}"><img src="loading.gif"></a>
      <h3><a href="${i.absolute ? "https://duoticket.com.br/" : ""}evento/${i.id}/${i.slug}">Evento ${i.id}</a></h3></div>`,
    )
    .join("\n");
  return `<!doctype html><html><head><title>Duoticket</title></head><body><nav><a href="/ajuda">Ajuda</a></nav>${cards}${extra}</body></html>`;
}

export function duoEventHtml(opts: { title: string; date: string; venue?: string | null; place?: string | null; time?: string; cancelled?: boolean; extraBody?: string }) {
  const venue = opts.venue === null ? "" : `<p>${opts.venue ?? "Casa de Testes"}</p>`;
  const place = opts.place === null ? "" : `<p>${opts.place ?? "Campinas | São Paulo"}</p>`;
  return `<!doctype html><html><head>
<meta property="og:title" content="${opts.title} - Duoticket">
<meta property="og:image" content="https://imagedelivery.net/x/perfil">
<script>window.secret = "nao-deve-vazar";</script>
</head><body>
<header><a href="/">Próximos Eventos</a></header>
<h1>${opts.title}</h1>
${opts.cancelled ? "<div class='alerta'>Evento cancelado</div>" : ""}
<a href="#ingressos">COMPRE AGORA!</a>
<div><span>DATA</span><p>${opts.date}</p></div>
${opts.time ? `<div><span>HORÁRIO</span><p>${opts.time}</p></div>` : ""}
<div><span>LOCAL</span>${venue}${place}</div>
<section><h2>Descrição</h2><p>Texto do produtor que não deve ser importado.</p>${opts.extraBody ?? ""}</section>
</body></html>`;
}

/** Fetcher falso: responde por URL; URL desconhecida = erro de rede (fonte instável). */
export function fakeFetcher(pages: Record<string, string>, calls: string[] = []) {
  return {
    calls,
    async html(url: string) {
      calls.push(url);
      const html = pages[url];
      if (html === undefined) throw new Error(`Falha de rede simulada: ${url}`);
      return { url, html };
    },
  };
}
