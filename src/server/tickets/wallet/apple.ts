// Apple Wallet: arquivo .pkpass (zip com pass.json, imagens, manifest e assinatura
// PKCS#7 com o certificado do Pass Type ID). Sem web service de atualização: um
// ingresso cancelado continua na carteira, mas a portaria valida online e recusa.
import "server-only";
import { PKPass } from "passkit-generator";
import { formatDateLong, formatDateShort, formatTime, timezoneLabel } from "@/lib/datetime";
import { qrPayload } from "../../services/tickets";
import type { AppleWalletConfig } from "./config";
import { APPLE_PASS_IMAGES } from "./images";
import type { WalletTicket } from "./types";

const images = () => Object.fromEntries(Object.entries(APPLE_PASS_IMAGES).map(([name, b64]) => [name, Buffer.from(b64, "base64")]));

export function applePassJson(t: WalletTicket, cfg: Pick<AppleWalletConfig, "passTypeIdentifier" | "teamIdentifier">) {
  const tz = t.event.timezone;
  return {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeIdentifier,
    teamIdentifier: cfg.teamIdentifier,
    serialNumber: t.code,
    organizationName: "Evento Brasil",
    description: `Ingresso: ${t.event.title}`,
    logoText: "Evento Brasil",
    foregroundColor: "rgb(255, 255, 255)",
    backgroundColor: "rgb(49, 46, 129)",
    labelColor: "rgb(196, 181, 253)",
    // Aparece na tela de bloqueio perto da hora do evento.
    relevantDate: t.event.startsAt.toISOString(),
    expirationDate: t.event.endsAt.toISOString(),
    barcodes: [{ format: "PKBarcodeFormatQR", message: qrPayload(t), messageEncoding: "iso-8859-1", altText: t.code }],
    eventTicket: {
      headerFields: [{ key: "date", label: "DATA", value: formatDateShort(t.event.startsAt, tz), textAlignment: "PKTextAlignmentRight" }],
      primaryFields: [{ key: "event", label: "EVENTO", value: t.event.title }],
      secondaryFields: [
        { key: "when", label: "QUANDO", value: `${formatDateLong(t.event.startsAt, tz)} · ${formatTime(t.event.startsAt, tz)} (${timezoneLabel(t.event.startsAt, tz)})` },
      ],
      auxiliaryFields: [
        { key: "type", label: "INGRESSO", value: t.ticketTypeName },
        ...(t.holderName ? [{ key: "holder", label: "TITULAR", value: t.holderName }] : []),
      ],
      backFields: [
        { key: "place", label: "Local", value: t.event.place || "Local a definir" },
        { key: "organizer", label: "Organizador", value: t.event.organizer },
        { key: "order", label: "Pedido", value: t.orderCode },
        { key: "code", label: "Código do ingresso", value: t.code },
        ...(t.kind === "HALF_PRICE" ? [{ key: "half", label: "Meia-entrada", value: "Apresente o documento comprobatório na entrada." }] : []),
        ...(t.isSimulated ? [{ key: "test", label: "Ingresso de teste", value: "Pagamento simulado: sem validade real." }] : []),
        { key: "rules", label: "Atenção", value: "Não compartilhe o QR code: ele é validado uma única vez na entrada." },
      ],
    },
  };
}

/** Gera o .pkpass assinado de um ingresso. */
export async function buildApplePass(t: WalletTicket, cfg: AppleWalletConfig): Promise<Buffer> {
  const pass = new PKPass(
    { ...images(), "pass.json": Buffer.from(JSON.stringify(applePassJson(t, cfg))) },
    { wwdr: cfg.wwdr, signerCert: cfg.signerCert, signerKey: cfg.signerKey, signerKeyPassphrase: cfg.signerKeyPassphrase },
  );
  return pass.getAsBuffer();
}
