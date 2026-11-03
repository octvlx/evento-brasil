// Base local de municípios do IBGE (src/data/ibge-municipios.json, versionada e
// atualizada só por `npm run ibge:update`). Nenhuma chamada ao IBGE em runtime.
// Só no servidor: o navegador recebe a lista de UMA UF (/api/municipios/[uf]).
import "server-only";
import data from "@/data/ibge-municipios.json";
import { isUF, type UF } from "@/lib/br";
import { compareMunicipalityNames, filterMunicipalities, normalizeMunicipalityName, type MunicipalityOption } from "@/lib/municipality-search";

export interface Municipality {
  id: number;
  nome: string;
  uf: UF;
}

const ALL = data as Municipality[];
const BY_ID = new Map(ALL.map((m) => [m.id, m]));
const BY_UF = new Map<UF, Municipality[]>();
for (const m of ALL) BY_UF.set(m.uf, [...(BY_UF.get(m.uf) ?? []), m]);
for (const list of BY_UF.values()) list.sort((a, b) => compareMunicipalityNames(a.nome, b.nome));

export function allMunicipalities(): readonly Municipality[] {
  return ALL;
}

/** Municípios da UF em ordem alfabética (vazio para UF inválida). */
export function municipalitiesByUf(uf: string): readonly Municipality[] {
  return isUF(uf) ? (BY_UF.get(uf) ?? []) : [];
}

/** Busca sem acentos/maiúsculas; com `uf`, só naquela UF. */
export function searchMunicipalities(query: string, opts: { uf?: string; limit?: number } = {}): Municipality[] {
  const pool = opts.uf ? municipalitiesByUf(opts.uf) : [...ALL].sort((a, b) => compareMunicipalityNames(a.nome, b.nome));
  return filterMunicipalities(pool, query, opts.limit ?? 20);
}

/** Código IBGE (número ou texto de 7 dígitos) → município, ou null. */
export function findMunicipality(code: unknown): Municipality | null {
  const id = typeof code === "number" ? code : typeof code === "string" && /^\d{7}$/.test(code.trim()) ? Number(code.trim()) : NaN;
  return BY_ID.get(id) ?? null;
}

/** O código existe E pertence à UF informada. */
export function validateMunicipality(code: unknown, uf: unknown): Municipality | null {
  const m = findMunicipality(code);
  return m && typeof uf === "string" && m.uf === uf.trim().toUpperCase() ? m : null;
}

/** Nome + UF → município (cidades antigas sem código). Ignora acentos e maiúsculas. */
export function findMunicipalityByName(name: string, uf: string): Municipality | null {
  const n = normalizeMunicipalityName(name);
  return municipalitiesByUf(uf).find((m) => normalizeMunicipalityName(m.nome) === n) ?? null;
}

export function municipalityOptions(uf: string): MunicipalityOption[] {
  return municipalitiesByUf(uf).map((m) => ({ id: m.id, nome: m.nome }));
}
