import { contentTypeForKey, readLocalUpload } from "@/server/storage";

// Serve uploads do armazenamento local (somente STORAGE_PROVIDER=local).
export async function GET(_req: Request, ctx: RouteContext<"/uploads/[...key]">) {
  const { key } = await ctx.params;
  const joined = key.join("/");
  if (!/^events\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(joined)) return new Response("Não encontrado", { status: 404 });
  const data = await readLocalUpload(joined);
  if (!data) return new Response("Não encontrado", { status: 404 });
  return new Response(new Uint8Array(data), {
    headers: { "content-type": contentTypeForKey(joined), "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}
