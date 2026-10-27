// Google Wallet: link "Salvar no Google Wallet" (https://pay.google.com/gp/v/save/<JWT>).
// O JWT, assinado com a chave da conta de serviço do emissor, já traz a classe do
// evento e o objeto do ingresso: o Google cria os dois ao salvar, sem chamada de API
// do nosso lado. O QR é o mesmo do ingresso e do PDF (validação online na portaria).
import "server-only";
import { createSign } from "node:crypto";
import { qrPayload } from "../../services/tickets";
import type { GoogleWalletConfig } from "./config";
import type { WalletTicket } from "./types";

const SAVE_URL = "https://pay.google.com/gp/v/save/";
const BRAND = "#312e81";

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");
const text = (value: string) => ({ defaultValue: { language: "pt-BR", value } });
// Ids do Google Wallet: "<issuerId>.<sufixo>", sufixo só com letras, números, ".", "_" e "-".
const suffix = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

export function googleWalletJwtPayload(tickets: WalletTicket[], cfg: GoogleWalletConfig, appUrl: string, now = new Date()) {
  const classes = new Map<string, object>();
  const objects = tickets.map((t) => {
    const classId = `${cfg.issuerId}.evento-${suffix(t.eventId)}`;
    if (!classes.has(classId)) {
      classes.set(classId, {
        id: classId,
        issuerName: "Evento Brasil",
        reviewStatus: "UNDER_REVIEW",
        eventName: text(t.event.title),
        venue: { name: text(t.event.place || "Local a definir"), address: text(t.event.place || "Local a definir") },
        dateTime: { start: t.event.startsAt.toISOString(), end: t.event.endsAt.toISOString() },
        hexBackgroundColor: BRAND,
      });
    }
    return {
      id: `${cfg.issuerId}.ingresso-${suffix(t.code)}`,
      classId,
      state: "ACTIVE",
      ticketHolderName: t.holderName ?? undefined,
      ticketNumber: t.code,
      ticketType: text(t.kind === "HALF_PRICE" ? `${t.ticketTypeName} (meia-entrada: documento na entrada)` : t.ticketTypeName),
      barcode: { type: "QR_CODE", value: qrPayload(t), alternateText: t.code },
      hexBackgroundColor: BRAND,
      ...(t.isSimulated ? { textModulesData: [{ id: "teste", header: "Ingresso de teste", body: "Pagamento simulado: sem validade real." }] } : {}),
    };
  });
  return {
    iss: cfg.serviceAccountEmail,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(now.getTime() / 1000),
    origins: [new URL(appUrl).origin],
    payload: { eventTicketClasses: [...classes.values()], eventTicketObjects: objects },
  };
}

/** URL de "Salvar no Google Wallet" para um ou mais ingressos (JWT RS256). */
export function googleWalletSaveUrl(tickets: WalletTicket[], cfg: GoogleWalletConfig, appUrl: string, now = new Date()): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(googleWalletJwtPayload(tickets, cfg, appUrl, now)));
  const signature = createSign("RSA-SHA256").update(`${header}.${body}`).sign(cfg.privateKey);
  return `${SAVE_URL}${header}.${body}.${b64url(signature)}`;
}
