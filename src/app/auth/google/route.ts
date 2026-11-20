import { NextRequest, NextResponse } from "next/server";
import { beginGoogleLogin, GOOGLE_FLOW_COOKIE } from "@/server/auth/google";
import { authAppUrl } from "@/server/services/email-verification";
import { rateLimit } from "@/server/rate-limit";
/**
 * Endereço que o navegador usou. Atrás de um túnel (ngrok, Cloudflare) o Next normaliza
 * `nextUrl` para localhost; o host real vem em X-Forwarded-Host / Host.
 */
function browserOrigin(req: NextRequest) {
  const first = (v: string | null) => v?.split(",")[0]?.trim() || null;
  const host = first(req.headers.get("x-forwarded-host")) ?? first(req.headers.get("host")) ?? req.nextUrl.host;
  const proto = first(req.headers.get("x-forwarded-proto")) ?? req.nextUrl.protocol.replace(":", "");
  return { host: host.toLowerCase(), origin: `${proto}://${host}` };
}

export async function GET(req: NextRequest) {
  let response: NextResponse;
  // Desenvolvimento: o retorno do Google vai para APP_URL. Aberto por outro endereço
  // (ex.: localhost com APP_URL de um túnel antigo), o cookie do fluxo fica no endereço
  // errado e o login sempre falha; avisa em vez de mandar para o Google à toa.
  // Compara o host (o cookie é por host), não o protocolo, que o túnel pode trocar.
  const browser = browserOrigin(req);
  if (process.env.NODE_ENV !== "production" && browser.host !== authAppUrl().host.toLowerCase()) {
    response = NextResponse.redirect(new URL("/entrar?googleError=app_url", browser.origin));
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  try {
    await rateLimit(`google-start:${req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local"}`, 20, 60_000);
    const start = beginGoogleLogin(req.nextUrl.searchParams.get("next"));
    response = NextResponse.redirect(start.url);
    response.cookies.set(GOOGLE_FLOW_COOKIE, start.cookie, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/auth/google", maxAge: 600 });
  } catch { response = NextResponse.redirect(new URL("/entrar?googleError=unavailable", authAppUrl())); }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
