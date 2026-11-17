import type { PdfTicket } from "../pdf";

/**
 * Dados de um ingresso para as carteiras: os mesmos do PDF, mais o evento (uma
 * classe/estilo por evento) e a identidade do QR (cada versão do QR é um passe).
 */
export type WalletTicket = PdfTicket & { eventId: string; ticketId: string; tokenVersion: number };
