import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { renderTicketsPdf, type PdfTicket } from "@/server/tickets/pdf";

const base: PdfTicket = {
  code: "ABCDEFGHJK",
  validationToken: "x".repeat(43),
  holderName: "Maria Teste",
  ticketTypeName: "Meia-entrada",
  orderCode: "EB-TESTE",
  isSimulated: false,
  event: { title: "Evento de teste", startsAt: new Date("2026-11-20T22:00:00Z"), endsAt: new Date("2026-11-21T02:00:00Z"), timezone: "America/Sao_Paulo", place: "Arena, Rio de Janeiro – RJ", organizer: "Org Teste", ageRestriction: 0 },
};

/** Conteúdo das páginas (streams Flate descompactados), onde o pdf-lib grava o texto em hexadecimal. */
function pageText(pdf: Uint8Array) {
  const raw = Buffer.from(pdf).toString("latin1");
  let out = "";
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try {
      out += inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      out += m[1];
    }
  }
  return out;
}

const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

describe("PDF do ingresso — meia-entrada", () => {
  it("mostra o aviso de documento só para HALF_PRICE", async () => {
    const half = pageText(await renderTicketsPdf([{ ...base, kind: "HALF_PRICE" }])).toUpperCase();
    const full = pageText(await renderTicketsPdf([{ ...base, kind: "GENERAL" }])).toUpperCase();
    const noKind = pageText(await renderTicketsPdf([base])).toUpperCase();
    const note = hex("MEIA-ENTRADA: APRESENTE O DOCUMENTO");
    expect(half).toContain(note);
    expect(full).not.toContain(note);
    expect(noKind).not.toContain(note);
  });
});
