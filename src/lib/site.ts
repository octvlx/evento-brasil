// URL pública do site (mesma origem usada em metadataBase no layout raiz).
// Imagem de compartilhamento padrão (src/app/opengraph-image.tsx). Páginas que definem
// openGraph substituem o herdado do layout e precisam repeti-la.
export const DEFAULT_OG_IMAGE = "/opengraph-image";

export const SITE_URL = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
