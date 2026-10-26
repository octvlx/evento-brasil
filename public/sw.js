// Service worker mínimo do PWA: cacheia apenas assets estáticos versionados.
// Páginas, ingressos e check-in são SEMPRE buscados na rede (sem modo offline
// no MVP), para nunca exibir estado desatualizado de pagamento ou ingresso.
const CACHE = "eb-static-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
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
