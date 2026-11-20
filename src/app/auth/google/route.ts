import { NextRequest, NextResponse } from "next/server";
import { beginGoogleLogin, GOOGLE_FLOW_COOKIE } from "@/server/auth/google";
import { authAppUrl } from "@/server/services/email-verification";
import { rateLimit } from "@/server/rate-limit";
export async function GET(req: NextRequest) {
  let response: NextResponse;
  // Desenvolvimento: o retorno do Google vai para APP_URL. Aberto por outro endereço
  // (ex.: localhost com APP_URL de um túnel antigo), o cookie do fluxo fica no endereço
  // errado e o login sempre falha; avisa em vez de mandar para o Google à toa.
  if (process.env.NODE_ENV !== "production" && req.nextUrl.origin !== authAppUrl().origin) {
    response = NextResponse.redirect(new URL("/entrar?googleError=app_url", req.nextUrl.origin));
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
