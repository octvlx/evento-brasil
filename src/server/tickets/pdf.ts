import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import type { TicketKind } from "@/generated/prisma/client";
import { formatDateLong, formatTime, timezoneLabel } from "@/lib/datetime";
import { qrPayload } from "../services/tickets";
import { organizerIdentityLine, type OrganizerIdentity } from "./organizer-identity";
import { BRAND } from "@/lib/brand";

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
  // Organizador responsável (L10b): razão social + CNPJ, ou nome da pessoa física. Quem não
  // passa (anexo do e-mail, por enquanto) cai no nome público da organização.
  organizerIdentity?: OrganizerIdentity;
}

// Cores da marca QQPega (tinta, pink, limão e cinza de apoio).
const NIGHT = rgb(0.086, 0.071, 0.122);
const PINK = rgb(0.82, 0.078, 0.353);
const LIME = rgb(0.776, 0.957, 0.196);
const GRAY = rgb(0.357, 0.333, 0.4);
const HALF_PRICE_NOTE = "MEIA-ENTRADA: APRESENTE O DOCUMENTO COMPROBATÓRIO NA ENTRADA";

/** Um ingresso por página A5 (retrato), com QR para validação online. */
export async function renderTicketsPdf(tickets: PdfTicket[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Ingressos — ${BRAND.name}`);
  pdf.setProducer(BRAND.name);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);

  for (const t of tickets) {
    const page = pdf.addPage([420, 595]);
    const { width } = page.getSize();
    page.drawRectangle({ x: 0, y: 515, width, height: 80, color: NIGHT });
    // Logotipo tipográfico: "QQ" em limão + "Pega" em branco (nome oficial: QQPega).
    page.drawText("QQ", { x: 28, y: 545, size: 22, font: bold, color: LIME });
    page.drawText("Pega", { x: 28 + bold.widthOfTextAtSize("QQ", 22), y: 545, size: 22, font: bold, color: rgb(1, 1, 1) });
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
    for (const line of wrap(t.event.title, 18, width - 56).slice(0, 2)) {
      page.drawText(line, { x: 28, y, size: 18, font: bold, color: NIGHT });
      y -= 22;
    }
    const tz = t.event.timezone;
    // Cada linha da tabela tem 1 ou 2 colunas; no máximo 2 linhas de texto por valor.
    // Pior caso (título e todos os valores com 2 linhas): última linha em y = 236, acima do QR (230).
    const half = (width - 56) / 2;
    const rows: [string, string][][] = [
      [["Data e horário", `${formatDateLong(t.event.startsAt, tz)}, ${formatTime(t.event.startsAt, tz)} às ${formatTime(t.event.endsAt, tz)} (${timezoneLabel(t.event.startsAt, tz)})`]],
      [["Local", t.event.place]],
      [
        ["Ingresso", t.ticketTypeName],
        ["Classificação", t.event.ageRestriction > 0 ? `${t.event.ageRestriction} anos` : "Livre"],
      ],
      [["Titular", t.holderName ?? "—"]],
      [["Organizador responsável", t.organizerIdentity ? organizerIdentityLine(t.organizerIdentity) : t.event.organizer]],
    ];
    y -= 6;
    for (const cols of rows) {
      const colWidth = cols.length === 1 ? width - 56 : half - 8;
      let lines = 1;
      cols.forEach(([label, value], i) => {
        const x = 28 + i * half;
        page.drawText(label.toUpperCase(), { x, y, size: 8, font: bold, color: GRAY });
        const wrapped = wrap(value, 11, colWidth, regular).slice(0, 2);
        wrapped.forEach((line, j) => page.drawText(line, { x, y: y - 12 - j * 14, size: 11, font: regular }));
        lines = Math.max(lines, wrapped.length);
      });
      y -= 12 + lines * 14 + 2;
    }

    const png = await QRCode.toBuffer(qrPayload(t), { errorCorrectionLevel: "M", margin: 1, width: 360 });
    const img = await pdf.embedPng(png);
    const size = 160;
    page.drawImage(img, { x: (width - size) / 2, y: 70, width: size, height: size });
    const codeText = `Código ${t.code}  ·  Pedido ${t.orderCode}`;
    page.drawText(codeText, { x: (width - regular.widthOfTextAtSize(codeText, 9)) / 2, y: 55, size: 9, font: regular, color: GRAY });
    const note = t.isSimulated ? "TESTE — pagamento simulado, ingresso sem valor" : `Organização: ${t.event.organizer}`;
    page.drawText(note, { x: (width - bold.widthOfTextAtSize(note, 8)) / 2, y: 38, size: 8, font: bold, color: t.isSimulated ? rgb(0.71, 0.07, 0.23) : PINK });
    const warn = "Não compartilhe este QR code. Ele é validado uma única vez na entrada.";
    page.drawText(warn, { x: (width - regular.widthOfTextAtSize(warn, 7.5)) / 2, y: 22, size: 7.5, font: regular, color: GRAY });
  }
  return pdf.save();
}
