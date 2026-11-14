import "server-only";
import type { OrderItem } from "@/generated/prisma/client";
import type { Tx } from "../db";
import { enqueueOrderEmailsTx } from "../email/events";
import { deriveQrToken, qrTokenHash, randomCode } from "../crypto";
import { qrPayload as formatQrPayload } from "@/lib/qr-payload";

// Formato do QR compartilhado com o leitor offline da portaria.
export { QR_PREFIX, parseQrPayload } from "@/lib/qr-payload";

/** Campos do ingresso que bastam para recalcular o token do QR. */
export interface QrTokenSource {
  code: string;
  tokenVersion: number;
  legacyValidationToken: string | null;
}

/**
 * Token do QR. Versão 0 (emitido antes do hash): o token aleatório antigo, se ainda
 * guardado; nulo depois do check-in, quando o QR não é mais exibido.
 */
export function ticketQrToken(t: QrTokenSource): string | null {
  if (t.tokenVersion > 0) return deriveQrToken(t.code, t.tokenVersion);
  return t.legacyValidationToken;
}

/** Colunas de uma versão nova do QR (a anterior deixa de valer). */
export function qrTokenColumns(code: string, version: number) {
  return { tokenVersion: version, validationTokenHash: qrTokenHash(deriveQrToken(code, version)), legacyValidationToken: null };
}

/** Conteúdo do QR, de um ingresso do banco ou de um token já calculado. */
export function qrPayload(t: QrTokenSource | { code: string; validationToken: string }): string {
  const token = "validationToken" in t ? t.validationToken : ticketQrToken(t);
  if (!token) throw new Error(`QR indisponível para o ingresso ${t.code}`);
  return formatQrPayload({ code: t.code, validationToken: token });
}

interface IssuableOrder {
  id: string;
  userId: string;
  eventId: string;
  buyerName: string;
  buyerEmail: string;
  items: OrderItem[];
}

function attendeeAt(item: OrderItem, index: number): { name?: string; email?: string } {
  const list = Array.isArray(item.attendees) ? (item.attendees as Array<{ name?: string; email?: string }>) : [];
  return list[index] ?? {};
}

/**
 * Emite um ingresso por unidade de cada item. Idempotente: a restrição única
 * (orderItemId, sequence) impede duplicidade mesmo com chamadas concorrentes.
 * Deve rodar dentro da transação que confirmou o pagamento.
 */
export async function issueTicketsTx(tx: Tx, order: IssuableOrder): Promise<number> {
  await enqueueOrderEmailsTx(tx, order.id);
  const expected = order.items.reduce((s, i) => s + i.quantity, 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await tx.issuedTicket.findMany({ where: { orderId: order.id }, select: { orderItemId: true, sequence: true } });
    if (existing.length >= expected) return existing.length;
    const have = new Set(existing.map((t) => `${t.orderItemId}:${t.sequence}`));
    const data = order.items.flatMap((item) =>
      Array.from({ length: item.quantity }, (_, i) => i + 1)
        .filter((seq) => !have.has(`${item.id}:${seq}`))
        .map((seq) => {
          const attendee = attendeeAt(item, seq - 1);
          const code = randomCode(10);
          return {
            code,
            orderId: order.id,
            orderItemId: item.id,
            eventId: order.eventId,
            ticketTypeId: item.ticketTypeId,
            userId: order.userId,
            sequence: seq,
            holderName: attendee.name ?? order.buyerName,
            holderEmail: attendee.email ?? order.buyerEmail,
            ...qrTokenColumns(code, 1),
          };
        }),
    );
    // ON CONFLICT DO NOTHING; a contagem é reconferida no próximo laço
    // (cobre a improvável colisão de código aleatório).
    await tx.issuedTicket.createMany({ data, skipDuplicates: true });
  }
  const final = await tx.issuedTicket.count({ where: { orderId: order.id } });
  if (final < expected) throw new Error(`Falha ao emitir ingressos do pedido ${order.id}`);
  return final;
}
