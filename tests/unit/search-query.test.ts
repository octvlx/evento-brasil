// Interpretação da busca em uma frase: termo + cidade (só cidades com evento
// público, passadas por quem chama), conectores do português, homônimos, acentos,
// categorias confiáveis e sugestões parciais ("Rock em São").
import { describe, expect, it } from "vitest";
import { cityMatchesPrefix, interpretSearch, matchCategory, sanitizeSearch, searchTokens, splitPartialLocation, stem, type SearchCity } from "@/lib/search-query";

const city = (name: string, state: string): SearchCity => ({ id: `${name}-${state}`, slug: `${name}-${state}`.toLowerCase().replace(/ /g, "-"), name, state });
const SP = city("São Paulo", "SP");
const RP = city("Ribeirão Preto", "SP");
const CWB = city("Curitiba", "PR");
const CPS = city("Campinas", "SP");
const RJ = city("Rio de Janeiro", "RJ");
const BH = city("Belo Horizonte", "MG");
const FLN = city("Florianópolis", "SC");
const SJC = city("São José dos Campos", "SP");
const NATAL = city("Natal", "RN");
const BJ_PI = city("Bom Jesus", "PI");
const BJ_RS = city("Bom Jesus", "RS");
const CITIES = [SP, RP, CWB, CPS, RJ, BH, FLN, SJC, NATAL, BJ_PI, BJ_RS];

const CATEGORIES = [
  { name: "Shows e música", slug: "shows-e-musica" },
  { name: "Festas", slug: "festas" },
  { name: "Teatro e espetáculos", slug: "teatro" },
  { name: "Stand-up", slug: "stand-up" },
  { name: "Festivais", slug: "festivais" },
  { name: "Esportes", slug: "esportes" },
];

describe("interpretSearch — termo + cidade", () => {
  it.each([
    ["Rock em São Paulo", "Rock", SP],
    ["Sertanejo em Ribeirão Preto", "Sertanejo", RP],
    ["Teatro em Curitiba", "Teatro", CWB],
    ["João Gomes em Campinas", "João Gomes", CPS],
    ["Festival em Belo Horizonte", "Festival", BH],
    ["Shows no Rio de Janeiro", "Shows", RJ],
    ["Música eletrônica em Florianópolis", "Música eletrônica", FLN],
    ["Festival na cidade de São Paulo", "Festival", SP],
    ["Stand-up em São José dos Campos", "Stand-up", SJC],
  ])("%s", (q, text, c) => {
    expect(interpretSearch(q, CITIES)).toMatchObject({ text, city: c, candidates: [], near: false });
  });

  it("sem acentos e com maiúsculas trocadas", () => {
    expect(interpretSearch("rock em sao paulo", CITIES)).toMatchObject({ text: "rock", city: SP });
    expect(interpretSearch("TEATRO EM CURITIBA", CITIES)).toMatchObject({ text: "TEATRO", city: CWB });
    expect(interpretSearch("musica eletronica em florianopolis", CITIES)).toMatchObject({ city: FLN });
  });

  it("só a cidade (com ou sem UF): filtro sem termo", () => {
    expect(interpretSearch("São Paulo", CITIES)).toMatchObject({ text: "", city: SP });
    expect(interpretSearch("ribeirao preto", CITIES)).toMatchObject({ text: "", city: RP });
    expect(interpretSearch("São Paulo — SP", CITIES)).toMatchObject({ text: "", city: SP });
    expect(interpretSearch("Bom Jesus RS", CITIES)).toMatchObject({ text: "", city: BJ_RS });
    expect(interpretSearch("Rock em Bom Jesus - PI", CITIES)).toMatchObject({ text: "Rock", city: BJ_PI });
  });

  it("homônimos sem UF: não filtra em silêncio e oferece as opções", () => {
    const r = interpretSearch("Rock em Bom Jesus", CITIES);
    expect(r).toMatchObject({ text: "Rock em Bom Jesus", city: null });
    expect(r.candidates).toEqual([BJ_PI, BJ_RS]);
    expect(interpretSearch("Bom Jesus", CITIES).candidates).toHaveLength(2);
  });

  it("sem cidade, termos que não são cidade e palavra comum que é cidade sem conector", () => {
    expect(interpretSearch("festival de música", CITIES)).toMatchObject({ text: "festival de música", city: null });
    expect(interpretSearch("Rock em Atlântida", CITIES)).toMatchObject({ text: "Rock em Atlântida", city: null });
    // "Natal" é cidade, mas sem conector é tema: "Show de Natal" não vira Natal – RN.
    expect(interpretSearch("Show de Natal", CITIES)).toMatchObject({ text: "Show de Natal", city: null });
    expect(interpretSearch("Show em Natal", CITIES)).toMatchObject({ text: "Show", city: NATAL });
  });

  it("perto de / próximo de: a própria cidade, marcada como aproximação", () => {
    expect(interpretSearch("Shows perto de Campinas", CITIES)).toMatchObject({ text: "Shows", city: CPS, near: true });
    expect(interpretSearch("teatro próximo de curitiba", CITIES)).toMatchObject({ text: "teatro", city: CWB, near: true });
  });

  it("cidade escolhida numa sugestão vence e a localização escrita sai do texto", () => {
    expect(interpretSearch("Rock em Bom Jesus", CITIES, BJ_RS)).toMatchObject({ text: "Rock", city: BJ_RS, candidates: [] });
    expect(interpretSearch("Rock em Curitiba", CITIES, SP)).toMatchObject({ text: "Rock", city: SP });
    expect(interpretSearch("Rock", CITIES, SP)).toMatchObject({ text: "Rock", city: SP });
  });

  it("só reconhece cidades da lista (cidades com evento público)", () => {
    expect(interpretSearch("Rock em Ribeirão Preto", [SP])).toMatchObject({ city: null, text: "Rock em Ribeirão Preto" });
  });

  it("limita e limpa o texto", () => {
    expect(sanitizeSearch("  rock   em   são paulo ")).toBe("rock em são paulo");
    expect(sanitizeSearch("x".repeat(500))).toHaveLength(80);
    expect(sanitizeSearch(42)).toBe("");
    expect(interpretSearch("", CITIES)).toMatchObject({ text: "", city: null });
  });
});

describe("sugestões parciais e categorias", () => {
  it("separa termo e início de cidade", () => {
    expect(splitPartialLocation("Rock em São")).toEqual({ text: "Rock", partialCity: "sao", connector: "em" });
    expect(splitPartialLocation("shows no rio de")).toMatchObject({ text: "shows", partialCity: "rio de" });
    expect(splitPartialLocation("Rock em")).toBeNull();
    expect(splitPartialLocation("Rock")).toBeNull();
  });

  it("prefixo de cidade por nome ou palavra", () => {
    expect(cityMatchesPrefix(SP, "sao")).toBe(1);
    expect(cityMatchesPrefix(SJC, "jose")).toBe(2);
    expect(cityMatchesPrefix(SP, "São Paulo")).toBe(0);
    expect(cityMatchesPrefix(CWB, "sao")).toBe(-1);
  });

  it("categoria só com correspondência confiável", () => {
    expect(matchCategory("Teatro", CATEGORIES)?.slug).toBe("teatro");
    expect(matchCategory("shows", CATEGORIES)?.slug).toBe("shows-e-musica");
    expect(matchCategory("Festival", CATEGORIES)?.slug).toBe("festivais");
    expect(matchCategory("música", CATEGORIES)?.slug).toBe("shows-e-musica");
    expect(matchCategory("Rock", CATEGORIES)).toBeNull();
    expect(matchCategory("Música eletrônica", CATEGORIES)).toBeNull();
    expect(matchCategory("João Gomes", CATEGORIES)).toBeNull();
  });

  it("palavras relevantes e singular aproximado", () => {
    expect(searchTokens("Festival de Música")).toEqual(["festival", "musica"]);
    expect(stem("festivais")).toBe("festival");
    expect(stem("shows")).toBe("show");
    expect(stem("rock")).toBe("rock");
  });
});
