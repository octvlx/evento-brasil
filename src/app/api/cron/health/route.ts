// Saúde operacional para monitor externo (ex.: verificação a cada 5 min com o header
// x-cron-secret). 200 sem problema crítico; 503 com algum. Só códigos e contagens,
// sem dados de pedidos ou pessoas.
import { db } from "@/server/db";
import { env } from "@/server/env";
import { safeEqual } from "@/server/crypto";
import { operationalHealth } from "@/server/services/ops-health";

export async function GET(req: Request) {
  const secret = req.headers.get("x-cron-secret") ?? "";
  if (!safeEqual(secret, env().CRON_SECRET)) return new Response("forbidden", { status: 403 });
  const checks = await operationalHealth(db);
  const critical = checks.some((c) => c.severity === "critical");
  return Response.json(
    {
      ok: !critical,
      problems: checks.map((c) => ({ code: c.code, severity: c.severity, count: c.count, oldestAt: c.oldestAt?.toISOString() ?? null })),
      at: new Date().toISOString(),
    },
    { status: critical ? 503 : 200, headers: { "cache-control": "no-store" } },
  );
}
