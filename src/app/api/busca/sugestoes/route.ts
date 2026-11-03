import { headers } from "next/headers";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { suggestSearch } from "@/server/services/search";

// Sugestões da busca pública (header e home). Só lê: nunca cria cidade nem evento.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  // Texto longo demais: nada a sugerir (a busca em si corta em 80 caracteres).
  if (q.length > 200) return Response.json({ groups: [] }, { status: 400 });
  const client = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  try {
    await rateLimit(`search-suggest:${client}`, 120, 60_000);
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") return Response.json({ groups: [], error: err.message }, { status: 429 });
    throw err;
  }
  return Response.json({ groups: await suggestSearch(db, q) }, { headers: { "cache-control": "private, max-age=30" } });
}
