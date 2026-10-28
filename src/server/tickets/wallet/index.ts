// Carteiras digitais: o que está ligado e os dados dos ingressos para gerar os passes.
import "server-only";
import type { Db } from "../../db";
import { env } from "../../env";
import type { PdfTicket } from "../pdf";
import { appleWalletConfig, googleWalletConfig } from "./config";
import type { WalletTicket } from "./types";

export { buildApplePass } from "./apple";
export { googleWalletSaveUrl } from "./google";
export type { WalletTicket } from "./types";

export const appleWallet = () => appleWalletConfig(env());
export const googleWallet = () => googleWalletConfig(env());

/** Quais carteiras aparecem para o comprador (sem configuração, nenhuma). */
export function walletAvailability() {
  return { apple: appleWallet() !== null, google: googleWallet() !== null };
}

/** Acrescenta evento e tipo aos ingressos de loadPdfTickets (não cancelados). */
export async function toWalletTickets(db: Db, tickets: PdfTicket[]): Promise<WalletTicket[]> {
  if (!tickets.length) return [];
  const extra = await db.issuedTicket.findMany({
    where: { code: { in: tickets.map((t) => t.code) } },
    select: { code: true, eventId: true, ticketType: { select: { kind: true } } },
  });
  const byCode = new Map(extra.map((e) => [e.code, e]));
  return tickets.map((t) => ({ ...t, eventId: byCode.get(t.code)!.eventId, kind: byCode.get(t.code)!.ticketType.kind }));
}
