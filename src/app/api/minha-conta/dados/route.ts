import { headers } from "next/headers";
import { db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { AppError } from "@/server/errors";
import { rateLimit } from "@/server/rate-limit";
import { exportUserDataAudited } from "@/server/services/data-export";

// "Baixar meus dados" (LGPD, R9): JSON só com os dados da conta da sessão.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response("Não autenticado", { status: 401 });
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  try {
    await rateLimit(`data-export:${user.id}`, 5, 60 * 60_000);
    const data = await exportUserDataAudited(db, user, { ip });
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="meus-dados-evento-brasil-${data.generatedAt.slice(0, 10)}.json"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") return new Response(err.message, { status: 429 });
    if (err instanceof AppError && err.code === "FORBIDDEN") return new Response(err.message, { status: 403 });
    throw err;
  }
}
