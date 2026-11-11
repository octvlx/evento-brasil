// Service worker mínimo do PWA: cacheia apenas assets estáticos versionados.
// Páginas e ingressos são SEMPRE buscados na rede, para nunca exibir estado
// desatualizado de pagamento ou ingresso. O leitor de check-in tem um worker
// próprio (escopo /check-in/, src/app/check-in/sw.js/route.ts) para abrir sem
// internet; o cache dele ("qqpega-checkin-*") não é deste worker e não é apagado aqui.
const CACHE = "eb-static-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    // Só versões antigas deste cache ("eb-static-*"); caches de outros workers ficam.
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("eb-static-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/_next/static/") && !url.pathname.startsWith("/icons/")) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    }),
  );
});
