import { logEvent } from "@/server/log";

// Web service de passes da Apple: o aparelho envia aqui os erros que encontrou ao
// atualizar um passe (útil para diagnosticar certificado ou URL). Só vai para o log.
export async function POST(req: Request) {
  const text = (await req.text().catch(() => "")).slice(0, 4000);
  let logs: unknown = [];
  try {
    logs = (JSON.parse(text) as { logs?: unknown }).logs ?? [];
  } catch {
    // corpo inválido: ignora
  }
  const lines = (Array.isArray(logs) ? logs : []).slice(0, 20).map((l) => String(l).slice(0, 300));
  if (lines.length) logEvent("warn", "wallet", "apple_device_log", { lines });
  return new Response(null, { status: 200 });
}
