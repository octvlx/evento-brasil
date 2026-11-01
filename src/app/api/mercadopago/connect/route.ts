import { NextResponse } from "next/server";
import { requireOrganizer } from "@/server/auth/organizer-context";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { beginConnection, MP_COOKIE, MP_TTL } from "@/server/payments/mercadopago-oauth";


export async function POST(request: Request) {
  const origin = new URL(env().APP_URL).origin;
  if (request.headers.get("origin") !== origin) return NextResponse.json({ error: "Origem inválida. Abra o site pelo endereço configurado." }, { status: 403 });
  const { user, org } = await requireOrganizer("/organizador/configuracoes");
  try {
    const flow = await beginConnection(db, user, org.id);
    const response = NextResponse.redirect(flow.url, 303);
    response.cookies.set(MP_COOKIE, flow.cookie, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: "/api/mercadopago", maxAge: MP_TTL });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return NextResponse.redirect(new URL("/organizador/configuracoes?mp=error", origin), 303);
  }
}
