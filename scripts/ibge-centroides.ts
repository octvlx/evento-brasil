// Atualiza o centro geográfico (centróide) de cada município (src/data/ibge-centroides.json)
// a partir da API de malhas do IBGE. Uso MANUAL, depois de `npm run ibge:update`:
//   npm run ibge:centroides
// Sem acesso à API, salve a resposta dela num arquivo por outro meio e rode:
//   npm run ibge:centroides -- --from-file caminho.json
//
// Serve para achar a cidade com eventos mais próxima de quem toca em "Usar minha
// localização" (src/server/nearest-city.ts). A localização da pessoa nunca sai do site.
// Só substitui o arquivo se tudo for válido; não faz commit e não toca no banco.
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CENTROIDS_SOURCE_URL = "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR/metadados?intrarregiao=municipio";
export const DEFAULT_CENTROIDS_PATH = path.resolve(import.meta.dirname, "../src/data/ibge-centroides.json");
const MUNICIPALITIES_PATH = path.resolve(import.meta.dirname, "../src/data/ibge-municipios.json");

/**
 * [código IBGE, latitude, longitude, sul, oeste, norte, leste]: o centro do município e o
 * retângulo que o envolve. O retângulo diz em que cidade a pessoa está: em municípios
 * grandes o centro geográfico fica longe do centro urbano (o do Rio fica a ~30 km), e
 * só a distância ao centro poria quem está no centro do Rio "mais perto" de Niterói.
 */
export type Centroid = [number, number, number, number, number, number, number];

// Caixa que contém todo o território brasileiro (com folga).
const LAT = [-34.5, 5.5] as const;
const LNG = [-74.5, -28.5] as const;
// Municípios recém-criados podem demorar a entrar na malha: tolera poucos sem centro.
const MAX_MISSING = 5;

type Coord = { latitude?: unknown; longitude?: unknown };
const inBrazil = (p: Coord | undefined): p is { latitude: number; longitude: number } =>
  typeof p?.latitude === "number" && typeof p.longitude === "number" && p.latitude >= LAT[0] && p.latitude <= LAT[1] && p.longitude >= LNG[0] && p.longitude <= LNG[1];
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Converte a resposta do IBGE em centróides validados e ordenados pelo código. Lança no primeiro problema. */
export function parseCentroids(raw: unknown, knownIds: ReadonlySet<number>): { centroids: Centroid[]; missing: number[] } {
  if (!Array.isArray(raw)) throw new Error("Resposta do IBGE não é uma lista.");
  const byId = new Map<number, Centroid>();
  raw.forEach((item: { id?: unknown; centroide?: Coord; "regiao-limitrofe"?: unknown }, i) => {
    const id = Number(item?.id);
    if (!/^\d{7}$/.test(String(item?.id))) throw new Error(`Item ${i}: código IBGE inválido.`);
    const c = item?.centroide;
    const box = item?.["regiao-limitrofe"];
    if (!inBrazil(c)) throw new Error(`Município ${id}: centróide fora do Brasil.`);
    if (!Array.isArray(box) || box.length !== 2 || !box.every((p) => inBrazil(p as Coord))) throw new Error(`Município ${id}: limites inválidos.`);
    const [a, b] = box as { latitude: number; longitude: number }[];
    const south = Math.min(a.latitude, b.latitude), north = Math.max(a.latitude, b.latitude);
    const west = Math.min(a.longitude, b.longitude), east = Math.max(a.longitude, b.longitude);
    if (c.latitude < south || c.latitude > north || c.longitude < west || c.longitude > east) throw new Error(`Município ${id}: centróide fora dos limites.`);
    if (byId.has(id)) throw new Error(`Código IBGE repetido: ${id}.`);
    // Só municípios da base local (ibge-municipios.json); os demais são ignorados.
    if (knownIds.has(id)) byId.set(id, [id, r4(c.latitude), r4(c.longitude), r4(south), r4(west), r4(north), r4(east)]);
  });
  const missing = [...knownIds].filter((id) => !byId.has(id)).sort((a, b) => a - b);
  if (missing.length > MAX_MISSING) throw new Error(`${missing.length} municípios da base local sem centróide (máximo ${MAX_MISSING}). Rode npm run ibge:update antes.`);
  return { centroids: [...byId.values()].sort((a, b) => a[0] - b[0]), missing };
}

/** Uma linha por município: diffs legíveis no Git. */
export function serializeCentroids(list: Centroid[]): string {
  return `[\n${list.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`;
}

export async function updateCentroids(opts: { fetchImpl?: typeof fetch; fromFile?: string; outPath?: string; log?: (msg: string) => void } = {}) {
  const { fetchImpl = fetch, outPath = DEFAULT_CENTROIDS_PATH, log = console.log } = opts;
  const known = new Set((JSON.parse(await readFile(MUNICIPALITIES_PATH, "utf8")) as { id: number }[]).map((m) => m.id));
  let raw: unknown;
  if (opts.fromFile) {
    log(`Lendo ${opts.fromFile} …`);
    raw = JSON.parse((await readFile(opts.fromFile, "utf8")).replace(/^﻿/, ""));
  } else {
    log(`Baixando ${CENTROIDS_SOURCE_URL} …`);
    const res = await fetchImpl(CENTROIDS_SOURCE_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`IBGE respondeu ${res.status}.`);
    raw = await res.json();
  }
  const { centroids, missing } = parseCentroids(raw, known);
  if (missing.length) log(`Sem centróide na malha do IBGE (ficam sem localização): ${missing.join(", ")}`);
  const tmp = `${outPath}.tmp`;
  try {
    await writeFile(tmp, serializeCentroids(centroids), "utf8");
    await rename(tmp, outPath);
  } finally {
    await rm(tmp, { force: true });
  }
  log(`Centróides atualizados: ${centroids.length} municípios. Revise o diff e faça o commit manualmente.`);
  return { count: centroids.length, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--from-file");
  updateCentroids({ fromFile: i > 0 ? process.argv[i + 1] : undefined }).catch((e) => {
    console.error(`Falha: ${e instanceof Error ? e.message : String(e)}`);
    console.error("O arquivo atual foi mantido.");
    process.exit(1);
  });
}
