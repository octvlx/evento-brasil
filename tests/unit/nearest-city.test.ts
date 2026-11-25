import { describe, expect, it } from "vitest";
import centroids from "@/data/ibge-centroides.json";
import municipios from "@/data/ibge-municipios.json";
import { cityArea, distanceKm, nearestCity } from "@/server/nearest-city";
import { parseCentroids, serializeCentroids } from "../../scripts/ibge-centroides";

const franca = { slug: "franca-sp", name: "Franca", state: "SP", ibgeCode: "3516200" };
const saoPaulo = { slug: "sao-paulo-sp", name: "São Paulo", state: "SP", ibgeCode: "3550308" };
const ribeirao = { slug: "ribeirao-preto-sp", name: "Ribeirão Preto", state: "SP", ibgeCode: null }; // cidade antiga, sem código

describe("distanceKm", () => {
  it("São Paulo → Rio de Janeiro fica perto de 360 km", () => {
    const km = distanceKm({ lat: -23.55, lng: -46.63 }, { lat: -22.91, lng: -43.17 });
    expect(km).toBeGreaterThan(340);
    expect(km).toBeLessThan(380);
  });
});

describe("nearestCity", () => {
  it("escolhe a cidade com eventos mais próxima do ponto", () => {
    const perto = nearestCity([saoPaulo, franca, ribeirao], { lat: -20.54, lng: -47.4 }); // centro de Franca
    expect(perto?.city.slug).toBe("franca-sp");
    expect(perto!.km).toBeLessThan(5);
  });

  it("acha o centro por nome + UF quando a cidade não tem código IBGE", () => {
    expect(cityArea(ribeirao)).not.toBeNull();
    expect(nearestCity([saoPaulo, ribeirao], { lat: -21.17, lng: -47.81 })?.city.slug).toBe("ribeirao-preto-sp");
  });

  it("quem está dentro do município fica nele, mesmo mais perto do centro de um vizinho", () => {
    const rio = { slug: "rio-de-janeiro-rj", name: "Rio de Janeiro", state: "RJ", ibgeCode: "3304557" };
    const niteroi = { slug: "niteroi-rj", name: "Niterói", state: "RJ", ibgeCode: "3303302" };
    const centroDoRio = { lat: -22.9068, lng: -43.1729 }; // ~29 km do centro geográfico do Rio, ~12 km do de Niterói
    expect(distanceKm(centroDoRio, cityArea(niteroi)!)).toBeLessThan(distanceKm(centroDoRio, cityArea(rio)!));
    expect(nearestCity([niteroi, rio], centroDoRio)).toEqual({ city: rio, km: 0 });
    // Rio sem eventos: vai para a cidade com eventos mais próxima, com a distância.
    const semRio = nearestCity([niteroi, saoPaulo], centroDoRio);
    expect(semRio?.city.slug).toBe("niteroi-rj");
    expect(semRio!.km).toBeGreaterThan(5);
  });

  it("ninguém perto (fora do raio) → null", () => {
    expect(nearestCity([saoPaulo, franca], { lat: -3.1, lng: -60.02 })).toBeNull(); // Manaus
  });

  it("cidade desconhecida na base do IBGE é ignorada", () => {
    expect(nearestCity([{ slug: "x", name: "Cidade Inventada", state: "SP", ibgeCode: null }], { lat: -23.55, lng: -46.63 })).toBeNull();
  });
});

describe("base de centróides versionada", () => {
  it("cobre a base de municípios (no máximo 5 sem centro) e fica dentro do Brasil", () => {
    const ids = new Set((municipios as { id: number }[]).map((m) => m.id));
    const list = centroids as number[][];
    expect(list.every(([id]) => ids.has(id))).toBe(true);
    expect(ids.size - list.length).toBeLessThanOrEqual(5);
    expect(list.every(([, lat, lng, s, w, n, e]) => lat > -34.5 && lat < 5.5 && lng > -74.5 && lng < -28.5 && s <= lat && lat <= n && w <= lng && lng <= e)).toBe(true);
  });
});

describe("ibge:centroides — validação da resposta", () => {
  const known = new Set([3516200, 3550308]);
  const item = (id: string, latitude: number, longitude: number) => ({
    id,
    centroide: { latitude, longitude },
    "regiao-limitrofe": [
      { latitude: latitude + 0.1, longitude: longitude - 0.1 },
      { latitude: latitude - 0.1, longitude: longitude + 0.1 },
    ],
  });

  it("converte, arredonda e ignora municípios fora da base local", () => {
    const { centroids: out, missing } = parseCentroids([item("3550308", -23.650123, -46.648111), item("3516200", -20.5552, -47.3811), item("9999999", -10, -50)], known);
    expect(out).toEqual([
      [3516200, -20.5552, -47.3811, -20.6552, -47.4811, -20.4552, -47.2811],
      [3550308, -23.6501, -46.6481, -23.7501, -46.7481, -23.5501, -46.5481],
    ]);
    expect(missing).toEqual([]);
    expect(serializeCentroids(out).split("\n")[1]).toBe("[3516200,-20.5552,-47.3811,-20.6552,-47.4811,-20.4552,-47.2811],");
  });

  it("recusa coordenada fora do Brasil, código inválido e resposta que não é lista", () => {
    expect(() => parseCentroids([item("3516200", 48.85, 2.35)], known)).toThrow(/fora do Brasil/);
    expect(() => parseCentroids([item("12", -20, -47)], known)).toThrow(/código IBGE inválido/);
    expect(() => parseCentroids({}, known)).toThrow(/não é uma lista/);
    expect(() => parseCentroids([{ id: "3516200", centroide: { latitude: -20.5, longitude: -47.4 } }], known)).toThrow(/limites inválidos/);
  });
});
