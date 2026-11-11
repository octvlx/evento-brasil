// Service worker do leitor de check-in: permite ABRIR (ou recarregar) o leitor sem
// internet, depois que a portaria baixou a lista offline. Escopo /check-in/ (só as
// páginas do leitor). Sempre tenta a rede primeiro; a cópia guardada só é usada sem
// conexão, então não atrapalha o desenvolvimento nem serve versão velha com internet.
// O leitor só registra este worker depois do download da lista, e sair da conta apaga
// a cópia e o registro (src/features/checkin/offline-store.ts).

const SOURCE = String.raw`
const CACHE = "qqpega-checkin-v1";
// Depois do pedido de limpeza (logout), não guarda nem responde mais nada até sumir.
let disabled = false;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const pageKey = (url) => {
  const u = new URL(url);
  return u.origin + u.pathname;
};
const isPage = (req, url) => req.mode === "navigate" && url.pathname.startsWith("/check-in/");
// Arquivos do próprio app (JS, CSS e fontes): os mesmos que a página do leitor carrega.
const isAsset = (url) => url.pathname.startsWith("/_next/static/");

async function put(cache, key, res) {
  // Só respostas completas do próprio site; redirecionamento (ex.: login) nunca vira o leitor.
  if (res.ok && !res.redirected && res.type === "basic") await cache.put(key, res.clone());
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "cache-urls" && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(CACHE).then((cache) =>
        Promise.all(
          data.urls.slice(0, 300).map(async (raw) => {
            try {
              const url = new URL(raw, self.location.origin);
              if (url.origin !== self.location.origin) return;
              if (!url.pathname.startsWith("/check-in/") && !isAsset(url)) return;
              const res = await fetch(url.href, { credentials: "same-origin", cache: "no-store" });
              if (!url.pathname.startsWith("/check-in/")) return put(cache, url.href, res);
              await put(cache, pageKey(url.href), res);
              // A página guardada é um HTML completo: guarda também todos os arquivos que ele
              // referencia (podem não ter sido carregados se o leitor foi aberto por navegação interna).
              if (!res.ok || res.redirected) return;
              const html = await res.clone().text();
              const refs = [...new Set(html.match(/\/_next\/static\/[^"'\s)<>]+/g) || [])].slice(0, 300);
              await Promise.all(
                refs.map(async (ref) => {
                  try {
                    const asset = new URL(ref.replace(/&amp;/g, "&"), self.location.origin).href;
                    if (await cache.match(asset)) return;
                    await put(cache, asset, await fetch(asset, { credentials: "same-origin" }));
                  } catch {}
                }),
              );
            } catch {}
          }),
        ),
      ),
    );
  }
  if (data.type === "clear") {
    disabled = true;
    event.waitUntil(Promise.all([caches.delete(CACHE), self.registration.unregister()]));
  }
});

const OFFLINE_HTML = '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sem internet</title><body style="font-family:system-ui,sans-serif;padding:24px;max-width:28rem;margin:auto"><h1 style="font-size:1.4rem">Sem internet</h1><p>Este leitor ainda não foi preparado para uso offline neste aparelho.</p><p>Com internet, abra o leitor do evento e toque em <strong>Baixar lista para uso offline</strong>.</p></body></html>';

self.addEventListener("fetch", (event) => {
  if (disabled) return;
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const page = isPage(req, url);
  if (!page && !isAsset(url)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = page ? pageKey(req.url) : req;
      try {
        const res = await fetch(req);
        await put(cache, key, res);
        return res;
      } catch (err) {
        const hit = await cache.match(key);
        if (hit) return hit;
        if (page) return new Response(OFFLINE_HTML, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
        throw err;
      }
    })(),
  );
});
`;

export function GET() {
  return new Response(SOURCE, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Sempre a versão atual do worker (guia de PWA do Next).
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'",
      // Escopo: só as páginas do leitor.
      "Service-Worker-Allowed": "/check-in/",
    },
  });
}
