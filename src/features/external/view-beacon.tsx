"use client";

import { useEffect } from "react";

/** Conta uma visualização (agregada) ao abrir a página; respeita "Não rastrear" do navegador. */
export function ExternalViewBeacon({ slug }: { slug: string }) {
  useEffect(() => {
    if (navigator.doNotTrack === "1" || (window as { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
    const url = `/api/externos/${encodeURIComponent(slug)}/visualizacao`;
    if (!navigator.sendBeacon?.(url)) void fetch(url, { method: "POST", keepalive: true }).catch(() => undefined);
  }, [slug]);
  return null;
}
