// Atualiza a base local de municípios (src/data/ibge-municipios.json) a partir da
// API oficial do IBGE. Uso MANUAL: npm run ibge:update [-- --allow-shrink]
// Sem acesso à API (ela bloqueia algumas redes), salve a resposta dela num arquivo
// por outro meio e rode: npm run ibge:update -- --from-file caminho.json --source "texto"
//
// - Baixa, valida (ids únicos de 7 dígitos coerentes com a UF, nomes, UFs) e ordena.
// - Mostra um resumo das mudanças em relação ao arquivo atual.
// - Só substitui os arquivos se tudo for válido; em qualquer erro o anterior fica.
// - Não faz commit e não toca no banco (a tabela City só ganha uma cidade quando
//   um evento é salvo nela — ver src/server/services/cities.ts).
// Nada no dev, build, deploy, migrations ou no cadastro de evento chama este script.
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UFS, type UF } from "../src/lib/br";

export const IBGE_SOURCE_URL = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios";
export const DEFAULT_DATA_PATH = path.resolve(import.meta.dirname, "../src/data/ibge-municipios.json");
export const DEFAULT_META_PATH = path.resolve(import.meta.dirname, "../src/data/ibge-municipios.meta.json");

export interface Municipality {
  id: number;
  nome: string;
  uf: UF;
}

export interface DatasetMeta {
  source: string;
  fetchedAt: string;
  count: number;
}

// Código IBGE da UF = 2 primeiros dígitos do código do município.
const UF_BY_CODE: Record<string, UF> = {
  "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
  "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL", "28": "SE", "29": "BA",
  "31": "MG", "32": "ES", "33": "RJ", "35": "SP",
  "41": "PR", "42": "SC", "43": "RS",
  "50": "MS", "51": "MT", "52": "GO", "53": "DF",
};
const VALID_UFS = new Set<string>(UFS.map((u) => u.uf));
// O Brasil tem ~5.570 municípios; fora desta faixa a resposta não é confiável.
const MIN_COUNT = 5000;
const MAX_COUNT = 6500;

interface RawMunicipio {
  id?: unknown;
  nome?: unknown;
  microrregiao?: { mesorregiao?: { UF?: { sigla?: unknown } } } | null;
  "regiao-imediata"?: { "regiao-intermediaria"?: { UF?: { sigla?: unknown } } } | null;
}

/** Converte a resposta do IBGE em `{id, nome, uf}`, validando cada item e o conjunto. Lança no primeiro problema. */
export function parseIbgeResponse(raw: unknown): Municipality[] {
  if (!Array.isArray(raw)) throw new Error("Resposta do IBGE não é uma lista.");
  const out = raw.map((item: RawMunicipio, i): Municipality => {
    const id = typeof item?.id === "string" ? Number(item.id) : item?.id;
    const uf = item?.microrregiao?.mesorregiao?.UF?.sigla ?? item?.["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla;
    const nome = typeof item?.nome === "string" ? item.nome.trim().replace(/\s+/g, " ") : "";
    if (typeof id !== "number" || !Number.isInteger(id)) throw new Error(`Item ${i}: id inválido.`);
    if (!nome || nome.length > 100) throw new Error(`Município ${id}: nome inválido.`);
    if (typeof uf !== "string" || !VALID_UFS.has(uf)) throw new Error(`Município ${id} (${nome}): UF inválida.`);
    return { id, nome, uf: uf as UF };
  });
  validateMunicipalities(out);
  return sortMunicipalities(out);
}

/** Regras de integridade da base (também usadas pelo teste do JSON versionado). */
export function validateMunicipalities(list: Municipality[]) {
  if (list.length < MIN_COUNT || list.length > MAX_COUNT) throw new Error(`Quantidade inesperada de municípios: ${list.length} (esperado entre ${MIN_COUNT} e ${MAX_COUNT}).`);
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const m of list) {
    if (!/^\d{7}$/.test(String(m.id))) throw new Error(`Município ${m.id}: o código IBGE deve ter 7 dígitos.`);
    if (ids.has(m.id)) throw new Error(`Código IBGE repetido: ${m.id}.`);
    ids.add(m.id);
    if (typeof m.nome !== "string" || !m.nome.trim() || m.nome !== m.nome.trim()) throw new Error(`Município ${m.id}: nome inválido.`);
    if (!VALID_UFS.has(m.uf)) throw new Error(`Município ${m.id}: UF inválida.`);
    if (UF_BY_CODE[String(m.id).slice(0, 2)] !== m.uf) throw new Error(`Município ${m.id} (${m.nome}): código não corresponde à UF ${m.uf}.`);
    // A tabela City tem @@unique([name, state]): nome repetido na mesma UF não cabe.
    const key = `${m.uf}|${m.nome}`;
    if (names.has(key)) throw new Error(`Nome repetido na mesma UF: ${m.nome} – ${m.uf}.`);
    names.add(key);
  }
  const ufs = new Set(list.map((m) => m.uf));
  const missing = [...VALID_UFS].filter((uf) => !ufs.has(uf as UF));
  if (missing.length) throw new Error(`UFs sem municípios: ${missing.join(", ")}.`);
}

/** Ordem determinística: pelo código IBGE. */
export function sortMunicipalities(list: Municipality[]): Municipality[] {
  return [...list].sort((a, b) => a.id - b.id);
}

/** Uma linha por município: diffs legíveis no Git e saída idêntica para a mesma entrada. */
export function serializeDataset(list: Municipality[]): string {
  return `[\n${list.map((m) => JSON.stringify({ id: m.id, nome: m.nome, uf: m.uf })).join(",\n")}\n]\n`;
}

export interface DatasetDiff {
  added: Municipality[];
  removed: Municipality[];
  changed: { before: Municipality; after: Municipality }[];
}

export function diffDatasets(before: Municipality[], after: Municipality[]): DatasetDiff {
  const old = new Map(before.map((m) => [m.id, m]));
  const next = new Map(after.map((m) => [m.id, m]));
  return {
    added: after.filter((m) => !old.has(m.id)),
    removed: before.filter((m) => !next.has(m.id)),
    changed: after.flatMap((m) => {
      const prev = old.get(m.id);
      return prev && (prev.nome !== m.nome || prev.uf !== m.uf) ? [{ before: prev, after: m }] : [];
    }),
  };
}

export function formatDiff(d: DatasetDiff, limit = 20): string {
  const label = (m: Municipality) => `${m.id} ${m.nome} – ${m.uf}`;
  const lines = [`Novos: ${d.added.length} · Removidos: ${d.removed.length} · Alterados: ${d.changed.length}`];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`${title}:`, ...items.slice(0, limit).map((s) => `  ${s}`));
    if (items.length > limit) lines.push(`  … e mais ${items.length - limit}`);
  };
  section("Novos", d.added.map((m) => `+ ${label(m)}`));
  section("Removidos", d.removed.map((m) => `- ${label(m)}`));
  section("Alterados", d.changed.map((c) => `~ ${label(c.before)} → ${c.after.nome} – ${c.after.uf}`));
  return lines.join("\n");
}

async function readCurrent(dataPath: string): Promise<Municipality[]> {
  try {
    return JSON.parse(await readFile(dataPath, "utf8")) as Municipality[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export interface UpdateOptions {
  fetchImpl?: typeof fetch;
  dataPath?: string;
  metaPath?: string;
  now?: Date;
  /** Aceita perder mais de 1% dos municípios (desmembramentos raros, revisão manual). */
  allowShrink?: boolean;
  /** Lê a resposta da API (mesmo formato) de um arquivo em vez de baixar. */
  fromFile?: string;
  /** Origem registrada nos metadados (padrão: a URL da API). */
  sourceLabel?: string;
  log?: (msg: string) => void;
}

export type UpdateResult = { status: "unchanged"; count: number } | { status: "updated"; count: number; diff: DatasetDiff };

/** Baixa, valida, compara e grava. Qualquer falha lança ANTES de tocar nos arquivos atuais. */
export async function updateMunicipalities(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const { fetchImpl = fetch, dataPath = DEFAULT_DATA_PATH, metaPath = DEFAULT_META_PATH, now = new Date(), log = console.log } = opts;
  let raw: unknown;
  if (opts.fromFile) {
    log(`Lendo ${opts.fromFile} …`);
    try {
      raw = JSON.parse((await readFile(opts.fromFile, "utf8")).replace(/^﻿/, ""));
    } catch {
      throw new Error("Arquivo informado não é JSON válido.");
    }
  } else {
    log(`Baixando ${IBGE_SOURCE_URL} …`);
    const res = await fetchImpl(IBGE_SOURCE_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`IBGE respondeu ${res.status}.`);
    try {
      raw = await res.json();
    } catch {
      throw new Error("Resposta do IBGE não é JSON válido.");
    }
  }
  const next = parseIbgeResponse(raw);
  const current = await readCurrent(dataPath);
  const diff = diffDatasets(current, next);
  log(formatDiff(diff));
  if (current.length && next.length < current.length * 0.99 && !opts.allowShrink)
    throw new Error(`A nova base tem ${next.length} municípios, contra ${current.length} hoje. Revise e rode com --allow-shrink para aceitar.`);

  const content = serializeDataset(next);
  if (current.length && content === serializeDataset(sortMunicipalities(current))) {
    log(`Sem mudanças (${next.length} municípios). Nenhum arquivo alterado.`);
    return { status: "unchanged", count: next.length };
  }
  const meta: DatasetMeta = { source: opts.sourceLabel ?? IBGE_SOURCE_URL, fetchedAt: now.toISOString(), count: next.length };
  // Grava ao lado e troca por rename: um erro no meio não deixa arquivo pela metade.
  const tmpData = `${dataPath}.tmp`;
  const tmpMeta = `${metaPath}.tmp`;
  try {
    await writeFile(tmpData, content, "utf8");
    await writeFile(tmpMeta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    // Confere o que foi escrito antes de substituir.
    validateMunicipalities(JSON.parse(await readFile(tmpData, "utf8")) as Municipality[]);
    await rename(tmpData, dataPath);
    await rename(tmpMeta, metaPath);
  } finally {
    await rm(tmpData, { force: true });
    await rm(tmpMeta, { force: true });
  }
  log(`Base atualizada: ${next.length} municípios. Revise o diff e faça o commit manualmente.`);
  return { status: "updated", count: next.length, diff };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  updateMunicipalities({ allowShrink: process.argv.includes("--allow-shrink"), fromFile: arg("--from-file"), sourceLabel: arg("--source") }).catch((e) => {
    console.error(`Falha: ${e instanceof Error ? e.message : String(e)}`);
    console.error("A base atual foi mantida.");
    process.exit(1);
  });
}
