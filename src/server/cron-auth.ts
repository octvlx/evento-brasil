import { safeEqual } from "@/server/crypto";
import { env } from "@/server/env";

/**
 * Autoriza as rotas de cron (/api/cron/*) pelo CRON_SECRET, em um de dois formatos:
 * - `x-cron-secret: <segredo>`: agendador externo (cron-job.org, Cloud Scheduler) e monitor;
 * - `Authorization: Bearer <segredo>`: Vercel Schedules/Cron Jobs, que enviam o
 *   CRON_SECRET do projeto assim (vercel.json).
 * Com o x-cron-secret presente, só ele vale: um cabeçalho errado não é salvo pelo outro.
 */
export function isCronAuthorized(req: Request): boolean {
  const expected = env().CRON_SECRET;
  const header = req.headers.get("x-cron-secret");
  if (header !== null) return safeEqual(header, expected);
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return bearer ? safeEqual(bearer[1], expected) : false;
}
