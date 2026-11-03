import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupPostalAddress } from "@/server/services/postal-address";
afterEach(() => vi.unstubAllGlobals());

describe("ViaCEP suggestions", () => {
  it("normalizes the CEP and only returns validated address fields", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ cep: "01001-000", logradouro: "Praça da Sé", bairro: "Sé", localidade: "São Paulo", uf: "SP", ignored: "not returned" }));
    vi.stubGlobal("fetch", fetch);
    expect(await lookupPostalAddress("01001-000")).toEqual({ postalCode: "01001000", street: "Praça da Sé", district: "Sé", city: "São Paulo", state: "SP", ibgeCode: "3550308" });
    expect(fetch.mock.calls[0][0]).toBe("https://viacep.com.br/ws/01001000/json/");
  });
  it("rejects invalid CEP without a network request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(lookupPostalAddress("01001A00")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows manual fallback after not found, provider failure, or mismatched response", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ erro: true })); vi.stubGlobal("fetch", fetch);
    await expect(lookupPostalAddress("99999999")).rejects.toMatchObject({ code: "NOT_FOUND" });
    fetch.mockRejectedValue(new Error("private network detail"));
    await expect(lookupPostalAddress("01001000")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    fetch.mockResolvedValue(Response.json({ cep: "99999-999", logradouro: "X", bairro: "Y", localidade: "Z", uf: "SP" }));
    await expect(lookupPostalAddress("01001000")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
  it("confere o município na base local do IBGE: pelo código, depois pelo nome; sem correspondência, null", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    // Código do ViaCEP (homônimo: Bom Jesus – RS, não – PI).
    fetch.mockResolvedValueOnce(Response.json({ cep: "95290-000", logradouro: "", bairro: "", localidade: "Bom Jesus", uf: "RS", ibge: "4302303" }));
    expect(await lookupPostalAddress("95290000")).toMatchObject({ city: "Bom Jesus", state: "RS", ibgeCode: "4302303" });
    // Código que não é da UF: ignorado; vale o nome + UF.
    fetch.mockResolvedValueOnce(Response.json({ cep: "80010-000", logradouro: "Rua XV", bairro: "Centro", localidade: "curitiba", uf: "PR", ibge: "3550308" }));
    expect(await lookupPostalAddress("80010000")).toMatchObject({ city: "Curitiba", ibgeCode: "4106902" });
    // Localidade fora da base: sugere o endereço, mas a cidade é escolhida à mão.
    fetch.mockResolvedValueOnce(Response.json({ cep: "80010-001", logradouro: "Rua A", bairro: "B", localidade: "Distrito Inexistente", uf: "PR" }));
    expect(await lookupPostalAddress("80010001")).toMatchObject({ city: "Distrito Inexistente", ibgeCode: null });
  });
});
