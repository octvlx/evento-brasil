import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import type { TicketKind } from "@/generated/prisma/client";
import { formatDateLong, formatTime, timezoneLabel } from "@/lib/datetime";
import { qrPayload } from "../services/tickets";

export interface PdfTicket {
  code: string;
  validationToken: string;
  holderName: string | null;
  ticketTypeName: string;
  // Opcional: quem monta o PDF sem o tipo (anexo do e-mail) simplesmente não mostra o aviso de meia.
  kind?: TicketKind;
  orderCode: string;
  isSimulated: boolean;
  event: { title: string; startsAt: Date; endsAt: Date; timezone: string; place: string; organizer: string; ageRestriction: number };
}

const INDIGO = rgb(0.192, 0.18, 0.506);
const VIOLET = rgb(0.486, 0.227, 0.929);
const GRAY = rgb(0.37, 0.35, 0.48);
const HALF_PRICE_NOTE = "MEIA-ENTRADA: APRESENTE O DOCUMENTO COMPROBATÓRIO NA ENTRADA";

/** Um ingresso por página A5 (retrato), com QR para validação online. */
export async function renderTicketsPdf(tickets: PdfTicket[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Ingressos — Evento Brasil");
  pdf.setProducer("Evento Brasil");
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);

  for (const t of tickets) {
    const page = pdf.addPage([420, 595]);
    const { width } = page.getSize();
    page.drawRectangle({ x: 0, y: 515, width, height: 80, color: INDIGO });
    page.drawText("evento", { x: 28, y: 545, size: 22, font: bold, color: rgb(1, 1, 1) });
    page.drawText("brasil", { x: 28 + bold.widthOfTextAtSize("evento", 22), y: 545, size: 22, font: bold, color: rgb(0.98, 0.45, 0.52) });
    page.drawText("INGRESSO", { x: width - 28 - bold.widthOfTextAtSize("INGRESSO", 11), y: 549, size: 11, font: bold, color: rgb(1, 1, 1) });
    if (t.kind === "HALF_PRICE") {
      // Faixa de alto contraste na base do cabeçalho: a portaria exige o documento.
      page.drawRectangle({ x: 0, y: 515, width, height: 20, color: rgb(0.99, 0.88, 0.28) });
      const size = Math.min(9, (9 * (width - 28)) / bold.widthOfTextAtSize(HALF_PRICE_NOTE, 9));
      page.drawText(HALF_PRICE_NOTE, { x: (width - bold.widthOfTextAtSize(HALF_PRICE_NOTE, size)) / 2, y: 522, size, font: bold, color: rgb(0, 0, 0) });
    }

    let y = 480;
    const wrap = (text: string, size: number, maxWidth: number, font = bold) => {
      const words = text.split(/\s+/);
      const lines: string[] = [];
      let line = "";
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
          lines.push(line);
          line = w;
        } else line = next;
      }
      if (line) lines.push(line);
      return lines;
    };
    for (const line of wrap(t.event.title, 18, width - 56)) {
      page.drawText(line, { x: 28, y, size: 18, font: bold, color: INDIGO });
      y -= 22;
    }
    const tz = t.event.timezone;
    const rows: [string, string][] = [
      ["Data", formatDateLong(t.event.startsAt, tz)],
      ["Horário", `${formatTime(t.event.startsAt, tz)} às ${formatTime(t.event.endsAt, tz)} (${timezoneLabel(t.event.startsAt, tz)})`],
      ["Local", t.event.place],
      ["Ingresso", t.ticketTypeName],
      ["Titular", t.holderName ?? "—"],
      ["Classificação", t.event.ageRestriction > 0 ? `${t.event.ageRestriction} anos` : "Livre"],
    ];
    y -= 6;
    for (const [label, value] of rows) {
      page.drawText(label.toUpperCase(), { x: 28, y, size: 8, font: bold, color: GRAY });
      y -= 13;
      for (const line of wrap(value, 11, width - 56, regular).slice(0, 2)) {
        page.drawText(line, { x: 28, y, size: 11, font: regular });
        y -= 14;
      }
      y -= 4;
    }

    const png = await QRCode.toBuffer(qrPayload(t), { errorCorrectionLevel: "M", margin: 1, width: 360 });
    const img = await pdf.embedPng(png);
    const size = 170;
    page.drawImage(img, { x: (width - size) / 2, y: 70, width: size, height: size });
    const codeText = `Código ${t.code}  ·  Pedido ${t.orderCode}`;
    page.drawText(codeText, { x: (width - regular.widthOfTextAtSize(codeText, 9)) / 2, y: 55, size: 9, font: regular, color: GRAY });
    const note = t.isSimulated ? "TESTE — pagamento simulado, ingresso sem valor" : `Organização: ${t.event.organizer}`;
    page.drawText(note, { x: (width - bold.widthOfTextAtSize(note, 8)) / 2, y: 38, size: 8, font: bold, color: t.isSimulated ? rgb(0.75, 0.07, 0.24) : VIOLET });
    const warn = "Não compartilhe este QR code. Ele é validado uma única vez na entrada.";
    page.drawText(warn, { x: (width - regular.widthOfTextAtSize(warn, 7.5)) / 2, y: 22, size: 7.5, font: regular, color: GRAY });
  }
  return pdf.save();
}
