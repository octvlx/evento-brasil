import { NextRequest, NextResponse } from "next/server";
import { beginGoogleLogin, GOOGLE_FLOW_COOKIE } from "@/server/auth/google";
import { authAppUrl } from "@/server/services/email-verification";
import { rateLimit } from "@/server/rate-limit";
export async function GET(req: NextRequest) {
  try {
    rateLimit(`google-start:${req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local"}`, 20, 60_000);
    const start = beginGoogleLogin(req.nextUrl.searchParams.get("next"));
    const response = NextResponse.redirect(start.url);
    response.cookies.set(GOOGLE_FLOW_COOKIE, start.cookie, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/auth/google", maxAge: 600 });
    return response;
  } catch { return NextResponse.redirect(new URL("/entrar?googleError=unavailable", authAppUrl())); }
}
