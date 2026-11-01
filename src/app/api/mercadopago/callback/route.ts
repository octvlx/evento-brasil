import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/current";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { finishConnection, MP_COOKIE } from "@/server/payments/mercadopago-oauth";


export async function GET(request: NextRequest) {
  let result = "error";
  try {
    const user = await getCurrentUser();
    const query = request.nextUrl.searchParams;
    if (!user || query.getAll("state").length !== 1 || query.getAll("code").length > 1 || query.getAll("error").length > 1) throw new Error("Invalid callback");
    const cookie = request.cookies.get(MP_COOKIE)?.value;
    const state = query.get("state");
    if (!cookie || !state || state.length > 256) throw new Error("Invalid callback");
    result = await finishConnection(db, user, cookie, state, query.get("code"), query.has("error"));
  } catch { /* No provider bodies, codes, tokens, or secrets in logs or redirects. */ }
  const response = NextResponse.redirect(new URL("/organizador/configuracoes?mp=" + result, env().APP_URL), 303);
  response.cookies.set(MP_COOKIE, "", { httpOnly: true, secure: new URL(env().APP_URL).protocol === "https:", sameSite: "lax", path: "/api/mercadopago", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
