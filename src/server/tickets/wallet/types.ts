import type { PdfTicket } from "../pdf";

/** Dados de um ingresso para as carteiras: os mesmos do PDF, mais o evento (uma classe/estilo por evento). */
export type WalletTicket = PdfTicket & { eventId: string };
