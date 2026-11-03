// Base local de municípios do IBGE: integridade do JSON versionado, busca sem
// acentos/maiúsculas, filtro por UF e validação de código + UF.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeDataset, sortMunicipalities, validateMunicipalities, type Municipality } from "../../scripts/ibge-update";
import { UFS } from "@/lib/br";
import { allMunicipalities, findMunicipality, findMunicipalityByName, municipalitiesByUf, municipalityOptions, searchMunicipalities, validateMunicipality } from "@/lib/municipalities";
import { filterMunicipalities, normalizeMunicipalityName } from "@/lib/municipality-search";

const dataPath = path.resolve(import.meta.dirname, "../../src/data/ibge-municipios.json");
const metaPath = path.resolve(import.meta.dirname, "../../src/data/ibge-municipios.meta.json");

describe("ibge-municipios.json (integridade)", () => {
  const raw = readFileSync(dataPath, "utf8");
  const list = JSON.parse(raw) as Municipality[];

  it("passa nas regras do script de atualização (ids, nomes, UFs, código coerente com a UF)", () => {
    expect(() => validateMunicipalities(list)).not.toThrow();
    expect(new Set(list.map((m) => m.uf))).toEqual(new Set(UFS.map((u) => u.uf)));
  });

  it("é determinístico: ordenado por código e no formato exato do script", () => {
    expect(list.map((m) => m.id)).toEqual(sortMunicipalities(list).map((m) => m.id));
    expect(raw).toBe(serializeDataset(list));
    for (const m of list) expect(Object.keys(m)).toEqual(["id", "nome", "uf"]);
  });

  it("metadados separados batem com a base", () => {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { source: string; fetchedAt: string; count: number };
    expect(meta.count).toBe(list.length);
    expect(meta.source).toBeTruthy();
    expect(Number.isNaN(Date.parse(meta.fetchedAt))).toBe(false);
  });

  it("nomes sem acento também não se repetem na mesma UF (busca por nome é inequívoca)", () => {
    const keys = list.map((m) => `${m.uf}|${normalizeMunicipalityName(m.nome)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("serviço de municípios", () => {
  it("busca sem diferenciar acentos e maiúsculas", () => {
    expect(searchMunicipalities("SAO PAULO", { uf: "SP" })[0]).toMatchObject({ id: 3550308, nome: "São Paulo", uf: "SP" });
    expect(searchMunicipalities("florianopolis")[0]).toMatchObject({ id: 4205407, uf: "SC" });
    expect(searchMunicipalities("sao joao d alianca", { uf: "GO" })[0]).toMatchObject({ id: 5220009 });
  });

  it("filtra por UF e ordena: nome igual, começo do nome, começo de palavra, trecho", () => {
    const bomJesus = searchMunicipalities("bom jesus", { limit: 50 });
    expect(bomJesus.filter((m) => m.nome === "Bom Jesus").map((m) => m.uf).sort()).toEqual(["PB", "PI", "RN", "RS", "SC"]);
    expect(searchMunicipalities("bom jesus", { uf: "RS" }).every((m) => m.uf === "RS")).toBe(true);
    expect(searchMunicipalities("bom jesus", { uf: "RS" })[0]).toMatchObject({ id: 4302303 });
    const list = [
      { id: 1, nome: "Alto Paraíso" },
      { id: 2, nome: "Paraíso" },
      { id: 3, nome: "Paraisópolis" },
      { id: 4, nome: "Novo Paraíso do Sul" },
    ];
    expect(filterMunicipalities(list, "paraiso").map((m) => m.id)).toEqual([2, 3, 1, 4]);
    expect(filterMunicipalities(list, "xyz")).toEqual([]);
    expect(filterMunicipalities(list, "", 2).map((m) => m.id)).toEqual([1, 2]);
  });

  it("lista por UF em ordem alfabética; UF inválida → vazio", () => {
    const sp = municipalitiesByUf("SP");
    expect(sp.length).toBeGreaterThan(600);
    expect(sp.every((m) => m.uf === "SP")).toBe(true);
    const names = sp.map((m) => m.nome);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "pt-BR", { sensitivity: "base" })));
    expect(municipalitiesByUf("XX")).toEqual([]);
    expect(municipalitiesByUf("sp")).toEqual([]);
    expect(municipalityOptions("DF")).toEqual([{ id: 5300108, nome: "Brasília" }]);
  });

  it("valida código + UF", () => {
    expect(validateMunicipality("4106902", "PR")).toMatchObject({ nome: "Curitiba" });
    expect(validateMunicipality(4106902, "PR")).toMatchObject({ nome: "Curitiba" });
    expect(validateMunicipality("4106902", "SC")).toBeNull(); // UF errada
    expect(validateMunicipality("9999999", "PR")).toBeNull(); // código inexistente
    expect(validateMunicipality("41069", "PR")).toBeNull();
    expect(validateMunicipality("4106902abc", "PR")).toBeNull();
    expect(validateMunicipality(undefined, undefined)).toBeNull();
    expect(findMunicipality("3550308")?.nome).toBe("São Paulo");
    expect(findMunicipalityByName("sao paulo", "SP")?.id).toBe(3550308);
    expect(findMunicipalityByName("São Paulo", "RJ")).toBeNull();
    expect(allMunicipalities().length).toBeGreaterThan(5500);
  });
});
