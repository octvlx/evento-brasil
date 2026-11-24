import { describe, expect, it } from "vitest";
import { absoluteUrl, eventJsonLd, jsonLdHtml, siteJsonLd, type EventJsonLdInput } from "@/lib/structured-data";

const base = "https://x.test";
const franca = { name: "Franca", state: "SP" };
const event: EventJsonLdInput = {
  title: "Show na Praça",
  slug: "show-na-praca",
  summary: "Um show ao ar livre.",
  description: "Descrição longa",
  startsAt: new Date("2026-12-05T23:00:00.000Z"),
  endsAt: new Date("2026-12-06T02:00:00.000Z"),
  locationType: "IN_PERSON",
  coverImageUrl: "https://cdn.x.test/capa.jpg",
  venue: { name: "Arena", addressLine: "Rua A, 10", district: "Centro", postalCode: "14400000", isFictional: false, city: franca },
  organization: { name: "Produtora", slug: "produtora" },
  salesStartAt: new Date("2026-11-01T12:00:00.000Z"),
  ticketTypes: [
    { id: "t1", name: "Inteira", available: 10, salesStartAt: null },
    { id: "t2", name: "Meia", available: 0, salesStartAt: new Date("2026-11-10T12:00:00.000Z") },
  ],
};
const totals = { t1: 5500, t2: 2750 };

describe("eventJsonLd", () => {
  it("leva endereço completo, imagem, organizador e ofertas com disponibilidade", () => {
    const ld = eventJsonLd(event, totals, { ended: false, base });
    expect(ld.url).toBe("https://x.test/eventos/show-na-praca");
    expect(ld.image).toEqual(["https://cdn.x.test/capa.jpg"]);
    expect(ld.location).toEqual({
      "@type": "Place",
      name: "Arena",
      address: { "@type": "PostalAddress", streetAddress: "Rua A, 10, Centro", addressLocality: "Franca", addressRegion: "SP", postalCode: "14400-000", addressCountry: "BR" },
    });
    expect(ld.organizer).toEqual({ "@type": "Organization", name: "Produtora", url: "https://x.test/organizadores/produtora" });
    expect(ld.offers).toEqual([
      expect.objectContaining({ price: "55.00", priceCurrency: "BRL", availability: "https://schema.org/InStock", validFrom: "2026-11-01T12:00:00.000Z" }),
      expect.objectContaining({ price: "27.50", availability: "https://schema.org/SoldOut", validFrom: "2026-11-10T12:00:00.000Z" }),
    ]);
  });

  it("evento encerrado não tem ofertas", () => {
    expect(eventJsonLd(event, totals, { ended: true, base })).not.toHaveProperty("offers");
  });

  it("local fictício mostra só a cidade; sem capa usa a imagem padrão absoluta", () => {
    const ld = eventJsonLd({ ...event, coverImageUrl: null, venue: { ...event.venue!, isFictional: true } }, totals, { ended: false, base });
    expect(ld.location).toEqual({ "@type": "Place", name: "Franca – SP", address: { "@type": "PostalAddress", addressLocality: "Franca", addressRegion: "SP", addressCountry: "BR" } });
    expect(ld.image).toEqual(["https://x.test/opengraph-image"]);
  });

  it("evento online usa VirtualLocation", () => {
    const ld = eventJsonLd({ ...event, locationType: "ONLINE", venue: null }, totals, { ended: false, base });
    expect(ld.location).toEqual({ "@type": "VirtualLocation", url: "https://x.test/eventos/show-na-praca" });
    expect(ld.eventAttendanceMode).toBe("https://schema.org/OnlineEventAttendanceMode");
  });
});

describe("siteJsonLd", () => {
  it("declara o site e a organização com logo e e-mail de suporte", () => {
    const [site, org] = siteJsonLd(base);
    expect(site).toMatchObject({ "@type": "WebSite", name: "TICKET24", url: "https://x.test/" });
    expect(org).toMatchObject({ "@type": "Organization", logo: "https://x.test/icons/icon.svg", contactPoint: { email: "suporte@ticket24.com.br" } });
  });
});

describe("utilitários", () => {
  it("absoluteUrl resolve caminhos relativos e mantém URLs absolutas", () => {
    expect(absoluteUrl("/placeholder/evento.svg", base)).toBe("https://x.test/placeholder/evento.svg");
    expect(absoluteUrl("https://cdn.x.test/a.jpg", base)).toBe("https://cdn.x.test/a.jpg");
  });

  it("jsonLdHtml não deixa fechar a tag script", () => {
    expect(jsonLdHtml({ name: "</script><script>alert(1)</script>" })).not.toContain("<");
  });
});
