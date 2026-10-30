import { NextRequest, NextResponse } from "next/server";
import { exchangeGoogleCode, findGoogleUser, GOOGLE_FLOW_COOKIE, GOOGLE_PENDING_COOKIE, sealGoogleCookie } from "@/server/auth/google";
import { authAppUrl, internalReturnPath } from "@/server/services/email-verification";
import { db } from "@/server/db";
import { createSession } from "@/server/auth/sessions";
import { SESSION_COOKIE } from "@/server/auth/current";
import { AppError } from "@/server/errors";
export async function GET(req: NextRequest) {
  let response: NextResponse;
  try {
    const identity = await exchangeGoogleCode(req.nextUrl.searchParams.get("code") ?? "", req.nextUrl.searchParams.get("state") ?? "", req.cookies.get(GOOGLE_FLOW_COOKIE)?.value);
    const user = await findGoogleUser(db, identity.subject, identity.email);
    if (user) {
      const session = await createSession(db, user.id, req.headers.get("user-agent"));
      response = NextResponse.redirect(new URL(internalReturnPath(identity.next), authAppUrl()));
      response.cookies.set(SESSION_COOKIE, session.token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: session.expiresAt });
    } else {
      response = NextResponse.redirect(new URL("/auth/google/consent", authAppUrl()));
      response.cookies.set(GOOGLE_PENDING_COOKIE, sealGoogleCookie("pending", identity), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 600 });
    }
  } catch (error) {
    response = NextResponse.redirect(new URL(`/entrar?googleError=${error instanceof AppError && error.code === "CONFLICT" ? "existing" : "unavailable"}`, authAppUrl()));
  }
  response.cookies.set(GOOGLE_FLOW_COOKIE, "", { path: "/auth/google", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
