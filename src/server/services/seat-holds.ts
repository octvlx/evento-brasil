// Assentos presos aos pedidos (lugar marcado). Separado de seats.ts para o serviço de
// pedidos usar sem importar o de eventos (evita ciclo de imports).
import "server-only";
import type { Db, Tx } from "../db";
import { AppError } from "../errors";

/**
 * Prende os assentos escolhidos ao item do pedido, na ordem dos ingressos (sequence 1, 2…).
 * Pré-condição: trava do evento (createOrder / pagamento tardio). Cada assento precisa ser
 * do tipo, estar livre e não bloqueado; senão SOLD_OUT com o rótulo, e a transação desfaz tudo.
 */
export async function claimSeatsTx(tx: Tx, orderItemId: string, ticketTypeId: string, seatIds: readonly string[]) {
  for (const [i, id] of seatIds.entries()) {
    const { count } = await tx.seat.updateMany({ where: { id, ticketTypeId, orderItemId: null, blocked: false }, data: { orderItemId, sequence: i + 1 } });
    if (count !== 1) {
      const seat = await tx.seat.findFirst({ where: { id, ticketTypeId }, select: { label: true } });
      throw new AppError("SOLD_OUT", seat ? `O assento ${seat.label} não está mais disponível. Escolha outro.` : "Assento inválido para este ingresso.");
    }
  }
}

/** Solta os assentos de um pedido que não foi pago (expirado, cancelado, falha). Pré-condição: trava do evento. */
export async function releaseSeatsTx(tx: Tx, orderId: string) {
  const { count } = await tx.seat.updateMany({ where: { orderItem: { orderId } }, data: { orderItemId: null, sequence: null } });
  return count;
}

/** Rótulo do assento de cada ingresso (orderItemId:sequence → "A12"), para ingresso, pedido e portaria. */
export async function seatLabelsFor(client: Db | Tx, tickets: readonly { orderItemId: string; sequence: number }[]) {
  const items = [...new Set(tickets.map((t) => t.orderItemId))];
  if (!items.length) return new Map<string, string>();
  const seats = await client.seat.findMany({ where: { orderItemId: { in: items } }, select: { orderItemId: true, sequence: true, label: true } });
  return new Map(seats.map((s) => [`${s.orderItemId}:${s.sequence}`, s.label]));
}
