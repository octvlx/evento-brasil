// npm run ibge:update: só substitui a base se tudo for válido; em qualquer falha
// (rede, HTTP, JSON, dados inválidos, base encolhendo) o arquivo anterior fica igual.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffDatasets, IBGE_SOURCE_URL, parseIbgeResponse, serializeDataset, updateMunicipalities, type Municipality } from "../../scripts/ibge-update";
import { UFS } from "@/lib/br";

// Base sintética válida: um município por UF (código com o prefixo certo) + extras em SP.
const UF_PREFIX: Record<string, number> = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 };
function fakeDataset(total = 5100): Municipality[] {
  const base = UFS.map((u) => ({ id: UF_PREFIX[u.uf] * 100000 + 1, nome: `Cidade ${u.uf}`, uf: u.uf }));
  const sp = Array.from({ length: total - UFS.length }, (_, i) => ({ id: 3500002 + i, nome: `Município ${i}`, uf: "SP" as const }));
  return [...base, ...sp];
}
const toApi = (list: { id: number; nome: string; uf: string }[]) => list.map((m) => ({ id: m.id, nome: m.nome, microrregiao: { mesorregiao: { UF: { sigla: m.uf } } } }));
const respond = (body: unknown, status = 200) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

let dir: string;
let dataPath: string;
let metaPath: string;
const ORIGINAL_META = `${JSON.stringify({ source: "teste", fetchedAt: "2026-01-01T00:00:00.000Z", count: 5100 }, null, 2)}\n`;
const silent = () => {};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ibge-"));
  dataPath = path.join(dir, "ibge-municipios.json");
  metaPath = path.join(dir, "ibge-municipios.meta.json");
  await writeFile(dataPath, serializeDataset(fakeDataset()));
  await writeFile(metaPath, ORIGINAL_META);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function expectUntouched() {
  expect(await readFile(dataPath, "utf8")).toBe(serializeDataset(fakeDataset()));
  expect(await readFile(metaPath, "utf8")).toBe(ORIGINAL_META);
  // Nenhum temporário esquecido.
  expect((await readdir(dir)).sort()).toEqual(["ibge-municipios.json", "ibge-municipios.meta.json"]);
}

describe("ibge:update — falhas preservam a base atual", () => {
  const networkDown = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const failures: [string, typeof fetch, RegExp][] = [
    ["rede fora", networkDown, /fetch failed/],
    ["HTTP 503", respond("indisponível", 503), /IBGE respondeu 503/],
    ["JSON quebrado", respond('[{"id": 1'), /não é JSON válido/],
    ["não é lista", respond({ erro: true }), /não é uma lista/],
    ["lista curta", respond(toApi(fakeDataset().slice(0, 100))), /Quantidade inesperada/],
    ["id repetido", respond(toApi([...fakeDataset(), fakeDataset()[0]])), /Código IBGE repetido/],
    ["UF inválida", respond(toApi([...fakeDataset(), { id: 3599999, nome: "X", uf: "XX" }])), /UF inválida/],
    ["código de outra UF", respond(toApi([...fakeDataset(), { id: 3599999, nome: "X", uf: "RJ" }])), /não corresponde à UF/],
    ["nome vazio", respond(toApi([...fakeDataset(), { id: 3599999, nome: "  ", uf: "SP" }])), /nome inválido/],
  ];
  for (const [name, fetchImpl, message] of failures)
    it(name, async () => {
      await expect(updateMunicipalities({ fetchImpl, dataPath, metaPath, log: silent })).rejects.toThrow(message);
      await expectUntouched();
    });

  it("base encolhendo mais de 1% exige --allow-shrink", async () => {
    const smaller = toApi(fakeDataset(5040));
    await expect(updateMunicipalities({ fetchImpl: respond(smaller), dataPath, metaPath, log: silent })).rejects.toThrow(/--allow-shrink/);
    await expectUntouched();
    await expect(updateMunicipalities({ fetchImpl: respond(smaller), dataPath, metaPath, log: silent, allowShrink: true })).resolves.toMatchObject({ status: "updated", count: 5040 });
  });
});

describe("ibge:update — sucesso", () => {
  it("sem mudanças: não reescreve nada", async () => {
    const shuffled = toApi([...fakeDataset()].reverse());
    await expect(updateMunicipalities({ fetchImpl: respond(shuffled), dataPath, metaPath, log: silent })).resolves.toEqual({ status: "unchanged", count: 5100 });
    await expectUntouched();
  });

  it("com mudanças: valida, ordena, grava base + metadados e resume o diff", async () => {
    const next = fakeDataset()
      .filter((m) => m.id !== 3500002)
      .map((m) => (m.id === 3500003 ? { ...m, nome: "Município Renomeado" } : m));
    next.push({ id: 3599990, nome: "Município Novo", uf: "SP" });
    const logs: string[] = [];
    const res = await updateMunicipalities({ fetchImpl: respond(toApi(next.reverse())), dataPath, metaPath, now: new Date("2026-11-03T12:00:00Z"), log: (m) => logs.push(m) });
    expect(res).toMatchObject({ status: "updated", count: 5100 });
    const written = JSON.parse(await readFile(dataPath, "utf8")) as Municipality[];
    expect(written.map((m) => m.id)).toEqual([...written.map((m) => m.id)].sort((a, b) => a - b));
    expect(JSON.parse(await readFile(metaPath, "utf8"))).toEqual({ source: IBGE_SOURCE_URL, fetchedAt: "2026-11-03T12:00:00.000Z", count: 5100 });
    expect(logs.join("\n")).toContain("Novos: 1 · Removidos: 1 · Alterados: 1");
    expect((await readdir(dir)).sort()).toEqual(["ibge-municipios.json", "ibge-municipios.meta.json"]);
  });

  it("lê de arquivo (--from-file) com a mesma validação", async () => {
    const file = path.join(dir, "dump.json");
    await writeFile(file, `﻿${JSON.stringify(toApi(fakeDataset(5101)))}`);
    await expect(updateMunicipalities({ fromFile: file, sourceLabel: "dump manual", dataPath, metaPath, log: silent, fetchImpl: respond("nunca chamado", 500) })).resolves.toMatchObject({ status: "updated", count: 5101 });
    expect(JSON.parse(await readFile(metaPath, "utf8")).source).toBe("dump manual");
  });

  it("parse aceita o formato novo do IBGE (regiao-imediata) e normaliza espaços", () => {
    const api = toApi(fakeDataset()).map((m) => (m.id === 1100001 ? { id: m.id, nome: "  Cidade   RO ", microrregiao: null, "regiao-imediata": { "regiao-intermediaria": { UF: { sigla: "RO" } } } } : m));
    expect(parseIbgeResponse(api)[0]).toEqual({ id: 1100001, nome: "Cidade RO", uf: "RO" });
    expect(diffDatasets([], parseIbgeResponse(api)).added).toHaveLength(5100);
  });
});
