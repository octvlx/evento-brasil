// Capa de evento externo: escolha da capa na página (não o logo/perfil), URL direta sem
// extensão, dimensões pelo cabeçalho, bloqueios de endereço interno e limites. Sem rede.
import { describe, expect, it } from "vitest";
import { findCoverCandidates, previewCover } from "@/server/external/cover";
import { imageDimensions } from "@/server/storage";

const publicDns = async () => ["104.18.10.10"];
const noSleep = async () => undefined;

function png(width: number, height: number) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}
function jpeg(width: number, height: number) {
  // SOI + APP0 curto + SOF0 com altura/largura.
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 0, 0, 0, 0, 0, 0]);
}

const TITLE = "Victor Lou - GBR - BAILE LOTADÃO - DJ SET";
const PAGE = "https://duoticket.com.br/evento/8965/Victor-Lou-GBR-BAILE-LOTADAO-DJ-SET";
const PERFIL = "https://imagedelivery.net/acc/f6065fe2-perfil-id/perfil";
const CAPA = "https://imagedelivery.net/acc/7468dfef-capa-id/capa";
const LOGO = "https://duoticket.com.br/img/logo.png";

// Mesma estrutura da página real: og:image é a versão quadrada "perfil"; a capa exibida
// é outra imagem carregada sob demanda (data-src) com o nome do evento no alt.
const duoPage = `<!doctype html><html><head>
<meta property="og:image" content="${PERFIL}">
<meta name="twitter:image" content="${PERFIL}">
</head><body>
<header><img src="${LOGO}" alt="Duoticket"></header>
<img src="loading.gif" data-src="${CAPA}" alt="Victor Lou - GBR - BAILE LOTAD&Atilde;O - DJ SET" class="lazy">
<img src="https://www.facebook.com/tr?id=1&ev=PageView" width="1" height="1">
</body></html>`;

function fakeFetch(routes: Record<string, () => Response>) {
  return (async (url: string | URL) => {
    const r = routes[String(url)];
    if (!r) return new Response("", { status: 404 });
    return r();
  }) as unknown as typeof fetch;
}
const image = (bytes: Uint8Array<ArrayBuffer>, type = "image/png") => () => new Response(bytes, { headers: { "content-type": type } });
const htmlRes = (s: string) => () => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("dimensões pelo cabeçalho", () => {
  it("lê PNG e JPEG; arquivo truncado ou não-imagem dá null", () => {
    expect(imageDimensions(png(800, 400))).toEqual({ width: 800, height: 400 });
    expect(imageDimensions(jpeg(1200, 600))).toEqual({ width: 1200, height: 600 });
    expect(imageDimensions(png(800, 400).slice(0, 20))).toBeNull();
    expect(imageDimensions(new TextEncoder().encode("<html>"))).toBeNull();
  });
});

describe("candidatos a capa na página", () => {
  it("a capa com o nome do evento vem antes do og:image 'perfil' e do logo; rastreadores ficam de fora", () => {
    const c = findCoverCandidates(duoPage, PAGE, TITLE);
    expect(c[0].url).toBe(CAPA);
    expect(c.map((x) => x.url)).toContain(PERFIL);
    expect(c.findIndex((x) => x.url === LOGO)).toBeGreaterThan(c.findIndex((x) => x.url === PERFIL));
    expect(c.some((x) => x.url.includes("facebook.com"))).toBe(false);
    expect(c.some((x) => x.url.endsWith("loading.gif"))).toBe(false);
  });
});

describe("prévia da capa", () => {
  const base = { resolveHost: publicDns, sleep: noSleep };

  it("página do evento: baixa os candidatos e escolhe a capa larga, não o perfil quadrado", async () => {
    const fetchImpl = fakeFetch({ [PAGE]: htmlRes(duoPage), [CAPA]: image(png(800, 400)), [PERFIL]: image(png(300, 300)), [LOGO]: image(png(120, 40)) });
    const p = await previewCover(PAGE, TITLE, { ...base, fetchImpl });
    expect(p.kind).toBe("page");
    expect(p.candidates[0]).toMatchObject({ url: CAPA, width: 800, height: 400, type: "image/png" });
    // O logo (pequeno demais) é descartado.
    expect(p.candidates.map((c) => c.url)).not.toContain(LOGO);
  });

  it("URL direta sem extensão é aceita quando o conteúdo é imagem (mesmo com tipo genérico)", async () => {
    const fetchImpl = fakeFetch({ [CAPA]: image(jpeg(1000, 500), "application/octet-stream") });
    const p = await previewCover(CAPA, TITLE, { ...base, fetchImpl });
    expect(p).toEqual({ kind: "direct", candidates: [expect.objectContaining({ url: CAPA, width: 1000, height: 500, type: "image/jpeg" })] });
  });

  it("conteúdo que não é imagem, imagem pequena ou página sem capa válida dão erro claro", async () => {
    const fake = fakeFetch({
      "https://x.example/fake": () => new Response("não é imagem", { headers: { "content-type": "image/png" } }),
      "https://x.example/mini": image(png(50, 50)),
      "https://x.example/pagina": htmlRes("<html><body><p>sem imagens</p></body></html>"),
      "https://x.example/json": () => new Response("{}", { headers: { "content-type": "application/json" } }),
    });
    const o = { ...base, fetchImpl: fake };
    await expect(previewCover("https://x.example/fake", null, o)).rejects.toThrow(/JPG, PNG ou WebP/);
    await expect(previewCover("https://x.example/mini", null, o)).rejects.toThrow(/pequena demais/);
    await expect(previewCover("https://x.example/pagina", null, o)).rejects.toThrow(/Não encontramos uma imagem de capa/);
    await expect(previewCover("https://x.example/json", null, o)).rejects.toThrow(/não é uma imagem nem uma página/);
  });

  it("bloqueia http, IP literal, host que resolve para rede interna e redirecionamento para rede interna", async () => {
    const fetchImpl = fakeFetch({
      "https://redireciona.example/img": () => new Response(null, { status: 302, headers: { location: "https://interno.example/img" } }),
      "https://interno.example/img": image(png(800, 400)),
    });
    const dns = async (host: string) => (host === "interno.example" ? ["10.0.0.8"] : ["104.18.10.10"]);
    const o = { resolveHost: dns, sleep: noSleep, fetchImpl };
    await expect(previewCover("http://redireciona.example/img", null, o)).rejects.toThrow(/Endereço não permitido/);
    await expect(previewCover("https://127.0.0.1/img", null, o)).rejects.toThrow(/Endereço não permitido/);
    await expect(previewCover("https://169.254.169.254/latest", null, o)).rejects.toThrow(/Endereço não permitido/);
    await expect(previewCover("https://interno.example/img", null, o)).rejects.toThrow(/Endereço não permitido/);
    await expect(previewCover("https://redireciona.example/img", null, o)).rejects.toThrow(/Endereço não permitido/);
  });

  it("pede só formatos validáveis (sem AVIF), para CDN com negociação entregar JPG/PNG/WebP", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).accept));
      return new Response(png(800, 400), { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;
    await previewCover(CAPA, null, { ...base, fetchImpl });
    expect(seen[0]).not.toMatch(/avif/);
    expect(seen[0]).toMatch(/image\/webp/);
  });

  it("recusa conteúdo acima de 5 MB", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    big.set(png(800, 400));
    const fetchImpl = fakeFetch({ "https://x.example/grande": image(big) });
    await expect(previewCover("https://x.example/grande", null, { ...base, fetchImpl })).rejects.toThrow(/grande demais/);
  });
});
