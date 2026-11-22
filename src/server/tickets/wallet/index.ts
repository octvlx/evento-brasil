// Carteiras digitais: o que está ligado e os dados dos ingressos para gerar os passes.
import "server-only";
import type { Db } from "../../db";
import { env } from "../../env";
import type { PdfTicket } from "../pdf";
import { appleWalletConfig, googleWalletConfig } from "./config";
import type { WalletTicket } from "./types";

export { buildApplePass } from "./apple";
export { googleWalletSaveUrl } from "./google";
export { applePassBundleForTickets, applePassForTicket, recordGoogleWalletPasses } from "./passes";
export type { WalletTicket } from "./types";

export const appleWallet = () => appleWalletConfig(env());
export const googleWallet = () => googleWalletConfig(env());

/** Quais carteiras aparecem para o comprador (sem configuração, nenhuma). */
export function walletAvailability() {
  const google = googleWallet() !== null;
  // QR rotativo do Google Wallet ligado (passe vale na portaria, online).
  return { apple: appleWallet() !== null, google, googleRotating: google && env().GOOGLE_WALLET_ROTATING_QR };
}

/**
 * Acrescenta evento, tipo e versão do QR aos ingressos de loadPdfTickets. Só ingressos
 * válidos vão para a carteira (usado ou cancelado não gera passe novo).
 */
export async function toWalletTickets(db: Db, tickets: PdfTicket[]): Promise<WalletTicket[]> {
  if (!tickets.length) return [];
  const extra = await db.issuedTicket.findMany({
    where: { code: { in: tickets.map((t) => t.code) }, status: "VALID" },
    select: { id: true, code: true, eventId: true, tokenVersion: true, ticketType: { select: { kind: true } } },
  });
  const byCode = new Map(extra.map((e) => [e.code, e]));
  return tickets.flatMap((t) => {
    const e = byCode.get(t.code);
    return e ? [{ ...t, eventId: e.eventId, ticketId: e.id, tokenVersion: e.tokenVersion, kind: e.ticketType.kind }] : [];
  });
}
