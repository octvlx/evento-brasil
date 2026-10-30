// Imported ONLY by the isolated E2E runner, never by the application.
if (process.env.E2E_ISOLATED !== "1" || process.env.NODE_ENV === "production") throw new Error("Postal test transport requires isolated development tests.");
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "viacep.com.br") return originalFetch(input, init);
  const cep = url.pathname.match(/^\/ws\/(\d{8})\/json\/$/)?.[1];
  if (cep === "01001000") return Response.json({ cep: "01001-000", logradouro: "Praça da Sé", bairro: "Sé", localidade: "São Paulo", uf: "SP" });
  if (cep === "01310930") return Response.json({ cep: "01310-930", logradouro: "Avenida Paulista", bairro: "Bela Vista", localidade: "São Paulo", uf: "SP" });
  return Response.json({ erro: true });
};
