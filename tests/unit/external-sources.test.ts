// Eventos externos: coleta segura (hosts autorizados, redes privadas, tamanho, tentativas)
// e o parser da Duoticket, só com amostras locais.
import { describe, expect, it, vi } from "vitest";
import { parseDuoticketEvent, parseDuoticketListing } from "@/server/external/adapters/duoticket";
import { assertFetchableUrl, isBlockedAddress, safeFetchHtml } from "@/server/external/safe-fetch";
import { cleanText, htmlToLines } from "@/server/external/text";
import { duoEventHtml, duoListingHtml } from "../support/external-fixtures";

const HOSTS = ["duoticket.com.br", "www.duoticket.com.br"];
const publicDns = async () => ["104.18.10.10"];
const html = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

describe("bloqueio de endereços internos", () => {
  it.each(["127.0.0.1", "10.0.0.5", "172.16.3.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])("%s é bloqueado", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(["104.18.10.10", "8.8.8.8", "2606:4700::1"])("%s é público", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it("recusa HTTP, host não autorizado, IP literal, credenciais, porta e DNS para rede privada", async () => {
    const opts = { allowedHosts: HOSTS, resolveHost: publicDns };
    await expect(assertFetchableUrl("http://duoticket.com.br/", opts)).rejects.toMatchObject({ kind: "blocked" });
    await expect(assertFetchableUrl("https://evil.example/", opts)).rejects.toMatchObject({ kind: "blocked" });
    await expect(assertFetchableUrl("https://duoticket.com.br.evil.example/", opts)).rejects.toMatchObject({ kind: "blocked" });
    await expect(assertFetchableUrl("https://127.0.0.1/", { ...opts, allowedHosts: ["127.0.0.1"] })).rejects.toMatchObject({ kind: "blocked" });
    await expect(assertFetchableUrl("https://user:pass@duoticket.com.br/", opts)).rejects.toMatchObject({ kind: "blocked" });
    await expect(assertFetchableUrl("https://duoticket.com.br:8443/", opts)).rejects.toMatchObject({ kind: "blocked" });
    await expect(assertFetchableUrl("https://duoticket.com.br/", { allowedHosts: HOSTS, resolveHost: async () => ["10.0.0.7"] })).rejects.toMatchObject({ kind: "blocked" });
    await expect(assertFetchableUrl("https://duoticket.com.br/evento/1/x", opts)).resolves.toBeInstanceOf(URL);
  });
});

describe("safeFetchHtml", () => {
  const base = { allowedHosts: HOSTS, resolveHost: publicDns, sleep: async () => undefined };

  it("segue redirecionamento só para host autorizado", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes("/antigo") ? new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) : html("<p>ok</p>"),
    ) as unknown as typeof fetch;
    await expect(safeFetchHtml("https://duoticket.com.br/antigo", { ...base, fetchImpl })).rejects.toMatchObject({ kind: "blocked" });

    const ok = vi.fn(async (url: string | URL) =>
      String(url).includes("/antigo") ? new Response(null, { status: 301, headers: { location: "/novo" } }) : html("<p>ok</p>"),
    ) as unknown as typeof fetch;
    await expect(safeFetchHtml("https://duoticket.com.br/antigo", { ...base, fetchImpl: ok })).resolves.toMatchObject({ url: "https://duoticket.com.br/novo", html: "<p>ok</p>" });
  });

  it("limita o tamanho da resposta e exige HTML", async () => {
    const big = (async () => html("x".repeat(2_000))) as unknown as typeof fetch;
    await expect(safeFetchHtml("https://duoticket.com.br/", { ...base, fetchImpl: big, maxBytes: 1_000 })).rejects.toMatchObject({ kind: "too_large" });
    const json = (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    await expect(safeFetchHtml("https://duoticket.com.br/", { ...base, fetchImpl: json })).rejects.toMatchObject({ kind: "content_type" });
  });

  it("tenta de novo com espera progressiva em falha temporária (503) e não repete erro definitivo (404)", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const flaky = (async () => (++n < 3 ? new Response("", { status: 503 }) : html("<p>ok</p>"))) as unknown as typeof fetch;
    await expect(safeFetchHtml("https://duoticket.com.br/", { ...base, fetchImpl: flaky, retries: 2, backoffMs: 100, sleep: async (ms) => void sleeps.push(ms) })).resolves.toMatchObject({ html: "<p>ok</p>" });
    expect(sleeps).toEqual([100, 200]);

    let calls = 0;
    const missing = (async () => (calls++, new Response("", { status: 404 }))) as unknown as typeof fetch;
    await expect(safeFetchHtml("https://duoticket.com.br/", { ...base, fetchImpl: missing, retries: 2 })).rejects.toMatchObject({ kind: "http", status: 404 });
    expect(calls).toBe(1);
  });
});

describe("texto de terceiros", () => {
  it("remove HTML, scripts, entidades perigosas e caracteres de controle", () => {
    expect(cleanText('&lt;script&gt;alert(1)&lt;/script&gt;Show <b>bom</b>\u0000 &amp; tal')).toBe("alert(1) Show bom & tal");
    expect(htmlToLines("<p>A</p><script>roubar()</script><style>x{}</style><p>B &eacute;</p>")).toEqual(["A", "B é"]);
  });
});

describe("parser da Duoticket", () => {
  it("lista ids únicos, só do próprio domínio, respeitando o limite", () => {
    const listing = duoListingHtml(
      [
        { id: "10", slug: "Show-A" },
        { id: "11", slug: "Show-B", absolute: true },
        { id: "10", slug: "Show-A" },
      ],
      '<a href="https://evil.example/evento/99/Falso">x</a><a href="evento/abc/x">x</a>',
    );
    expect(parseDuoticketListing(listing, 10)).toEqual([
      { sourceEventId: "10", url: "https://duoticket.com.br/evento/10/Show-A" },
      { sourceEventId: "11", url: "https://duoticket.com.br/evento/11/Show-B" },
    ]);
    expect(parseDuoticketListing(listing, 1)).toHaveLength(1);
  });

  it("extrai título, data, local, cidade e UF; sem horário e sem preço quando a página não informa", () => {
    const e = parseDuoticketEvent(duoEventHtml({ title: "Festa &amp; Música", date: "06/12/2026" }), { sourceEventId: "10", url: "https://duoticket.com.br/evento/10/Show-A" });
    expect(e).toEqual({
      sourceEventId: "10",
      sourceUrl: "https://duoticket.com.br/evento/10/Show-A",
      title: "Festa & Música",
      localDate: "2026-12-06",
      localTime: null,
      venueName: "Casa de Testes",
      cityName: "Campinas",
      state: "SP",
      categoryName: null,
      price: { status: "UNKNOWN" },
      cancelled: false,
    });
  });

  it("horário só com rótulo explícito, cancelamento explícito e título malicioso vira texto", () => {
    const e = parseDuoticketEvent(
      duoEventHtml({ title: "&lt;img src=x onerror=alert(1)&gt;Noite", date: "31/01/2027", time: "22h30", cancelled: true, place: "Manaus | Amazonas" }),
      { sourceEventId: "12", url: "https://duoticket.com.br/evento/12/x" },
    );
    expect(e.title).toBe("Noite");
    expect(e.localTime).toBe("22:30");
    expect(e.cancelled).toBe(true);
    expect(e).toMatchObject({ cityName: "Manaus", state: "AM" });
  });

  it("recusa página sem data ou com data impossível", () => {
    const d = { sourceEventId: "13", url: "https://duoticket.com.br/evento/13/x" };
    expect(() => parseDuoticketEvent(duoEventHtml({ title: "Sem data", date: "em breve" }), d)).toThrow(/Data/);
    expect(() => parseDuoticketEvent(duoEventHtml({ title: "Data ruim", date: "31/02/2027" }), d)).toThrow(/Data/);
  });
});
