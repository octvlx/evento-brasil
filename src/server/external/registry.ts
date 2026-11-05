import "server-only";
import { duoticketAdapter } from "./adapters/duoticket";
import type { ExternalSourceAdapter } from "./types";

// Só fontes com forma autorizada de coleta têm adaptador. Sympla e Q2 Ingressos ficam
// cadastradas como NEEDS_AUTHORIZATION (motivo em ExternalSource.notes), sem adaptador:
// nada é coletado delas até existir API, feed ou acordo.
const ADAPTERS: Record<string, ExternalSourceAdapter> = {
  [duoticketAdapter.key]: duoticketAdapter,
};

export function adapterFor(key: string): ExternalSourceAdapter | null {
  return ADAPTERS[key] ?? null;
}
