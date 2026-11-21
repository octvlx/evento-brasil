import { describe, expect, it } from "vitest";
import { buildIcs, eventAddress, googleCalendarUrl, mapLinks } from "@/lib/event-links";

const sp = { name: "São Paulo", state: "SP" };
const ev = {
  id: "evt1",
  title: String.raw`Show; com, vírgulas\barra`,
  description: "Linha 1\nLinha 2",
  location: "Arena, Rua A, 10 – Centro, São Paulo – SP",
  url: "https://x.test/eventos/show",
  startsAt: new Date("2026-12-05T23:00:00.000Z"),
  endsAt: new Date("2026-12-06T02:30:00.000Z"),
};

describe("eventAddress", () => {
  it("monta o endereço com o nome do local e diz se dá para mapear", () => {
    const a = eventAddress({ locationType: "IN_PERSON", venue: { name: "Arena", addressLine: "Rua A, 10", district: "Centro", postalCode: "01001000", isFictional: false, city: sp } });
    expect(a?.full).toMatch(/^Arena, Rua A, 10 – Centro, São Paulo – SP, CEP 01001-000$/);
    expect(a?.address.startsWith("Rua A")).toBe(true);
    expect(a?.mappable).toBe(true);
  });
  it("só a cidade não é mapeável; local fictício fica só com a cidade; online não tem endereço", () => {
    expect(eventAddress({ locationType: "IN_PERSON", city: sp, venue: null })?.mappable).toBe(false);
    expect(eventAddress({ locationType: "ONLINE", city: sp })).toBeNull();
    expect(eventAddress({ locationType: "IN_PERSON", venue: { name: "Demo", isFictional: true, city: sp } })).toEqual({ full: "São Paulo – SP", address: "São Paulo – SP", mappable: false });
  });
});

describe("mapLinks", () => {
  it("codifica o endereço nas URLs do Google Maps e do Waze", () => {
    const m = mapLinks("Rua A, 10 – São Paulo");
    expect(m.googleMaps).toBe("https://www.google.com/maps/search/?api=1&query=Rua%20A%2C%2010%20%E2%80%93%20S%C3%A3o%20Paulo");
    expect(m.waze).toContain("https://waze.com/ul?q=Rua%20A%2C%2010");
    expect(m.waze).toContain("&navigate=yes");
  });
});

describe("buildIcs", () => {
  const ics = buildIcs(ev, "x.test", new Date("2026-11-21T12:00:00.000Z"));
  it("gera VEVENT em UTC com CRLF e escapes do RFC 5545", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("UID:evt1@x.test");
    expect(ics).toContain("DTSTART:20261205T230000Z");
    expect(ics).toContain("DTEND:20261206T023000Z");
    expect(ics).toContain("DTSTAMP:20261121T120000Z");
    expect(ics).toContain(String.raw`SUMMARY:Show\; com\, vírgulas\\barra`);
    expect(ics.replace(/\r\n /g, "")).toContain(String.raw`DESCRIPTION:Linha 1\nLinha 2\n\nhttps://x.test/eventos/show`);
    expect(ics.split("\r\n").every((l) => l === "" || !/[\r\n]/.test(l))).toBe(true);
  });
  it("dobra linhas longas em até 75 octetos sem partir acentos", () => {
    const long = buildIcs({ ...ev, title: "Ç".repeat(100) }, "x.test");
    const lines = long.split("\r\n");
    expect(lines.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(long.replace(/\r\n /g, "")).toContain(`SUMMARY:${"Ç".repeat(100)}`);
  });
  it("omite LOCATION quando não há local", () => {
    expect(buildIcs({ ...ev, location: null }, "x.test")).not.toContain("LOCATION:");
  });
});

describe("googleCalendarUrl", () => {
  it("leva título, datas UTC, detalhes e local", () => {
    const u = new URL(googleCalendarUrl(ev));
    expect(u.origin + u.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(u.searchParams.get("action")).toBe("TEMPLATE");
    expect(u.searchParams.get("dates")).toBe("20261205T230000Z/20261206T023000Z");
    expect(u.searchParams.get("location")).toBe(ev.location);
    expect(u.searchParams.get("details")).toContain(ev.url);
  });
});
