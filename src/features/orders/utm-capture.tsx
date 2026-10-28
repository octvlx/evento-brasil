"use client";

import { useEffect } from "react";
import { captureUtmAction } from "./actions";

/** Captura UTMs soltos da URL do evento no cookie de atribuição (sem link rastreado). */
export function UtmCapture() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const utms = Object.fromEntries([...params].filter(([k]) => k.startsWith("utm_")));
    if (Object.keys(utms).length) void captureUtmAction(utms);
  }, []);
  return null;
}
