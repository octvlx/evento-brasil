// Apple Wallet: arquivo .pkpass (zip com pass.json, imagens, manifest e assinatura
// PKCS#7 com o certificado do Pass Type ID). Um passe por versão do QR
// (serialNumber "<código>-v<versão>"). Com APP_URL em HTTPS, o passe aponta para o
// web service de atualização (passes.ts): reembolso, cancelamento, uso ou
// transferência fazem o aparelho baixar o passe de novo, anulado e sem QR.
import "server-only";
import { PKPass } from "passkit-generator";
import { formatDateLong, formatDateShort, formatTime, timezoneLabel } from "@/lib/datetime";
import { qrPayload } from "../../services/tickets";
import type { AppleWalletConfig } from "./config";
import { APPLE_PASS_IMAGES } from "./images";
import type { WalletTicket } from "./types";
import { BRAND } from "@/lib/brand";

const images = () => Object.fromEntries(Object.entries(APPLE_PASS_IMAGES).map(([name, b64]) => [name, Buffer.from(b64, "base64")]));

/** serialNumber do passe: um por versão do QR (a transferência gera outro passe). */
export const appleSerial = (code: string, tokenVersion: number) => `${code}-v${tokenVersion}`;

export interface ApplePassOptions {
  /** Web service de atualização (só com HTTPS) e o token que o aparelho apresenta. */
  webService?: { url: string; authenticationToken: string };
  /** Ingresso usado, reembolsado, cancelado ou QR substituído: sem QR e marcado como anulado. */
  voided?: boolean;
  /** Passe de uma versão anterior do QR (ingresso transferido): sem o nome do titular atual. */
  hideHolder?: boolean;
}

export function applePassJson(t: WalletTicket, cfg: Pick<AppleWalletConfig, "passTypeIdentifier" | "teamIdentifier">, opts: ApplePassOptions = {}) {
  const tz = t.event.timezone;
  const holder = opts.hideHolder ? null : t.holderName;
  return {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeIdentifier,
    teamIdentifier: cfg.teamIdentifier,
    serialNumber: appleSerial(t.code, t.tokenVersion),
    ...(opts.webService ? { webServiceURL: opts.webService.url, authenticationToken: opts.webService.authenticationToken } : {}),
    organizationName: BRAND.name,
    description: `Ingresso: ${t.event.title}`,
    logoText: BRAND.name,
    foregroundColor: "rgb(255, 255, 255)",
    backgroundColor: "rgb(22, 18, 31)",
    labelColor: "rgb(198, 244, 50)",
    // Aparece na tela de bloqueio perto da hora do evento.
    relevantDate: t.event.startsAt.toISOString(),
    expirationDate: t.event.endsAt.toISOString(),
    ...(opts.voided ? { voided: true } : { barcodes: [{ format: "PKBarcodeFormatQR", message: qrPayload(t), messageEncoding: "iso-8859-1", altText: t.code }] }),
    eventTicket: {
      headerFields: [{ key: "date", label: "DATA", value: formatDateShort(t.event.startsAt, tz), textAlignment: "PKTextAlignmentRight" }],
      primaryFields: [{ key: "event", label: "EVENTO", value: t.event.title }],
      secondaryFields: [
        { key: "when", label: "QUANDO", value: `${formatDateLong(t.event.startsAt, tz)} · ${formatTime(t.event.startsAt, tz)} (${timezoneLabel(t.event.startsAt, tz)})` },
      ],
      auxiliaryFields: [
        { key: "type", label: "INGRESSO", value: t.ticketTypeName },
        ...(holder ? [{ key: "holder", label: "TITULAR", value: holder }] : []),
      ],
      backFields: [
        { key: "place", label: "Local", value: t.event.place || "Local a definir" },
        { key: "organizer", label: "Organizador", value: t.event.organizer },
        { key: "order", label: "Pedido", value: t.orderCode },
        { key: "code", label: "Código do ingresso", value: t.code },
        ...(opts.voided ? [{ key: "voided", label: "Situação", value: "Este passe não vale mais para entrar. Veja o ingresso no site." }] : []),
        ...(t.kind === "HALF_PRICE" ? [{ key: "half", label: "Meia-entrada", value: "Apresente o documento comprobatório na entrada." }] : []),
        ...(t.isSimulated ? [{ key: "test", label: "Ingresso de teste", value: "Pagamento simulado: sem validade real." }] : []),
        { key: "rules", label: "Atenção", value: "Não compartilhe o QR code: ele é validado uma única vez na entrada." },
      ],
    },
  };
}

/** Gera o .pkpass assinado de um ingresso. */
function createApplePass(t: WalletTicket, cfg: AppleWalletConfig, opts: ApplePassOptions): PKPass {
  return new PKPass(
    { ...images(), "pass.json": Buffer.from(JSON.stringify(applePassJson(t, cfg, opts))) },
    { wwdr: cfg.wwdr, signerCert: cfg.signerCert, signerKey: cfg.signerKey, signerKeyPassphrase: cfg.signerKeyPassphrase },
  );
}

export async function buildApplePass(t: WalletTicket, cfg: AppleWalletConfig, opts: ApplePassOptions = {}): Promise<Buffer> {
  return createApplePass(t, cfg, opts).getAsBuffer();
}

/** Vários ingressos num arquivo .pkpasses (iOS 15+ adiciona todos de uma vez). */
export function buildApplePassBundle(items: { ticket: WalletTicket; opts?: ApplePassOptions }[], cfg: AppleWalletConfig): Buffer {
  return PKPass.pack(...items.map((i) => createApplePass(i.ticket, cfg, i.opts ?? {}))).getAsBuffer();
}
