import { utcToZonedLocalInput } from "@/lib/datetime";

/**
 * Dias até o sábado dos eventos de demonstração "deste fim de semana". Hoje sendo sábado,
 * só vale hoje até o meio-dia: os eventos de sábado começam às 16h e 18h e a venda fecha
 * 2 h depois do início, então à noite as compras de demonstração do seed seriam recusadas
 * ("vendas encerradas"). A partir do meio-dia de sábado, usa o sábado seguinte.
 */
export function daysToSaturday(tz: string, now = new Date()): number {
  const local = utcToZonedLocalInput(now, tz); // AAAA-MM-DDTHH:mm no fuso
  const dow = new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay();
  const days = (6 - dow + 7) % 7;
  return days === 0 && Number(local.slice(11, 13)) >= 12 ? 7 : days;
}
