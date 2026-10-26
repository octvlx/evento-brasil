import { db } from "@/server/db";
import { getAdapterById } from "@/server/payments";
import { handlePaymentWebhook } from "@/server/services/payments";

const MAX_BODY = 64 * 1024;

export async function POST(req: Request, ctx: RouteContext<"/api/webhooks/[provider]">) {
  const { provider } = await ctx.params;
  const adapter = getAdapterById(provider);
  if (!adapter) return new Response("unknown provider", { status: 404 });
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY) return new Response("payload too large", { status: 413 });
  const result = await handlePaymentWebhook(db, adapter, { headers: req.headers, rawBody, url: new URL(req.url) });
  return new Response(result.body, { status: result.status, headers: { "content-type": "text/plain" } });
}
