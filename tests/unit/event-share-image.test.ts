import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ env: { OBJECT_STORAGE_PUBLIC_URL: "https://cdn.ticket24.test/media" as string | undefined }, local: vi.fn() }));
vi.mock("@/server/env", () => ({ env: () => mocks.env }));
vi.mock("@/server/storage", async (orig) => ({ ...(await orig<typeof import("@/server/storage")>()), readLocalUpload: mocks.local }));

import { ownCoverDataUri, shareLabels } from "@/server/og/event-share";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const base = {
  title: "Noite de Samba no Terraço",
  startsAt: new Date("2026-11-28T21:00:00Z"),
  timezone: "America/Sao_Paulo",
  locationType: "VENUE" as const,
  categoryName: "Shows e música",
  city: { name: "São Paulo", state: "SP" },
  venueName: "Terraço Aurora",
  minTotalCents: 4000,
  ended: false,
  soldOut: false,
};

describe("textos da imagem de compartilhamento", () => {
  it("data no fuso do evento, local e preço", () => {
    expect(shareLabels(base)).toEqual({ date: "Sáb, 28 de novembro · 18:00", place: "Terraço Aurora · São Paulo – SP", price: "A partir de R$ 40,00", category: "Shows e música", titleSize: 80 });
  });

  it("gratuito, esgotado, encerrado, online e sem ingresso à venda", () => {
    expect(shareLabels({ ...base, minTotalCents: 0 }).price).toBe("Gratuito");
    expect(shareLabels({ ...base, soldOut: true }).price).toBe("Esgotado");
    expect(shareLabels({ ...base, ended: true }).price).toBe("Evento encerrado");
    expect(shareLabels({ ...base, minTotalCents: null }).price).toBeNull();
    expect(shareLabels({ ...base, locationType: "ONLINE", city: null, venueName: null }).place).toBe("Evento online");
  });

  it("título longo fica menor", () => {
    expect(shareLabels({ ...base, title: "x".repeat(50) }).titleSize).toBe(66);
    expect(shareLabels({ ...base, title: "x".repeat(90) }).titleSize).toBe(54);
  });
});

describe("capa: só do armazenamento do próprio site", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    mocks.local.mockReset();
    mocks.env.OBJECT_STORAGE_PUBLIC_URL = "https://cdn.ticket24.test/media";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lê o upload local e o bucket público; PNG vira data URI", async () => {
    mocks.local.mockResolvedValue(Buffer.from(PNG));
    expect(await ownCoverDataUri("/uploads/org/capa.png")).toMatch(/^data:image\/png;base64,/);
    expect(mocks.local).toHaveBeenCalledWith("org/capa.png");
    fetchMock.mockResolvedValue(new Response(PNG, { status: 200 }));
    expect(await ownCoverDataUri("https://cdn.ticket24.test/media/org/capa.png")).toMatch(/^data:image\/png;base64,/);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it("não busca URL de fora, com '..' ou sem bucket configurado (sem SSRF)", async () => {
    for (const url of ["https://evil.test/x.png", "http://169.254.169.254/latest", "https://cdn.ticket24.test/mediax/a.png", "https://cdn.ticket24.test/media/../x.png", "/placeholder/a.svg"])
      expect(await ownCoverDataUri(url)).toBeNull();
    mocks.env.OBJECT_STORAGE_PUBLIC_URL = undefined;
    expect(await ownCoverDataUri("https://cdn.ticket24.test/media/a.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("WebP, falha de rede ou arquivo grande caem no fundo da marca", async () => {
    mocks.local.mockResolvedValue(Buffer.from(WEBP));
    expect(await ownCoverDataUri("/uploads/a.webp")).toBeNull();
    fetchMock.mockRejectedValue(new Error("timeout"));
    expect(await ownCoverDataUri("https://cdn.ticket24.test/media/a.png")).toBeNull();
    fetchMock.mockResolvedValue(new Response(PNG, { status: 200, headers: { "content-length": String(6 * 1024 * 1024) } }));
    expect(await ownCoverDataUri("https://cdn.ticket24.test/media/a.png")).toBeNull();
    expect(await ownCoverDataUri(null)).toBeNull();
  });
});
