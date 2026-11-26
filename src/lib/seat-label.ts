// Assento de um ingresso (lugar marcado): o Seat do mesmo item do pedido com a mesma
// sequência. Use SEAT_OF_TICKET no include do IssuedTicket e seatOf para ler.
export const SEAT_OF_TICKET = { select: { seats: { select: { sequence: true, label: true } } } } as const;

export function seatOf(t: { sequence: number; orderItem?: { seats: { sequence: number | null; label: string }[] } | null }): string | null {
  return t.orderItem?.seats.find((s) => s.sequence === t.sequence)?.label ?? null;
}
