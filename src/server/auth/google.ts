import "server-only";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { encryptPII, decryptPII, randomToken } from "../crypto";
import { env } from "../env";
import { AppError } from "../errors";
import { authAppUrl, internalReturnPath } from "../services/email-verification";
import type { Db } from "../db";
import { assertActive } from "./permissions";

const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 5000 });
const unavailable = () => new AppError("PROVIDER_ERROR", "Não foi possível entrar com Google. Tente novamente ou use e-mail e senha.");
// Relógio do servidor alguns segundos atrás do Google fazia o "iat" parecer futuro e o
// login falhar (visto com 0,1–0,5 s de diferença). Margem usual para iat/exp.
const GOOGLE_CLOCK_TOLERANCE = 60;
export const GOOGLE_FLOW_COOKIE = "eb_google_flow";
export const GOOGLE_PENDING_COOKIE = "eb_google_pending";
export const googleIdentitySchema = z.object({ subject: z.string().min(1).max(255), email: z.string().email().max(200).transform(v => v.toLowerCase()), name: z.string().trim().min(2).max(120), next: z.string() });
export const googleFlowSchema = z.object({ state: z.string().min(32), nonce: z.string().min(32), verifier: z.string().min(43), next: z.string() });
export function googleConfigured() { return !!(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET); }
export function sealGoogleCookie(kind: "flow" | "pending", value: unknown) { return encryptPII(JSON.stringify({ kind, value, expiresAt: Date.now() + 10 * 60_000 })); }
export function readGoogleCookie(kind: "flow" | "pending", raw?: string): unknown {
  try {
    const data = JSON.parse(decryptPII(raw ?? ""));
    if (data.kind !== kind || typeof data.expiresAt !== "number" || data.expiresAt <= Date.now()) throw unavailable();
    return kind === "flow" ? googleFlowSchema.parse(data.value) : googleIdentitySchema.parse(data.value);
  } catch { throw unavailable(); }
}
export function beginGoogleLogin(next?: string | null) {
  if (!googleConfigured()) throw unavailable();
  const flow = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48), next: internalReturnPath(next) };
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  const values = { client_id: env().GOOGLE_CLIENT_ID!, redirect_uri: new URL("/auth/google/callback", authAppUrl()).toString(), response_type: "code", scope: "openid email profile", state: flow.state, nonce: flow.nonce, code_challenge: createHash("sha256").update(flow.verifier).digest("base64url"), code_challenge_method: "S256" };
  Object.entries(values).forEach(([k,v]) => url.searchParams.set(k,v));
  return { url: url.toString(), cookie: sealGoogleCookie("flow", flow) };
}
export async function validateGoogleIdToken(idToken: string, nonce: string, audience = env().GOOGLE_CLIENT_ID!, resolver: JWTVerifyGetKey = keys) {
  try {
    const { payload } = await jwtVerify(idToken, resolver, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience, algorithms: ["RS256"], requiredClaims: ["sub", "email", "email_verified", "nonce", "iat", "exp"], maxTokenAge: "10m", clockTolerance: GOOGLE_CLOCK_TOLERANCE });
    if (payload.nonce !== nonce || payload.email_verified !== true || (payload.azp && payload.azp !== audience)) throw unavailable();
    return googleIdentitySchema.omit({ next: true }).parse({ subject: payload.sub, email: payload.email, name: typeof payload.name === "string" ? payload.name : "Pessoa Google" });
  } catch { throw unavailable(); }
}
export async function exchangeGoogleCode(code: string, state: string, rawCookie?: string) {
  const flow = googleFlowSchema.parse(readGoogleCookie("flow", rawCookie));
  if (state !== flow.state || !code || code.length > 4096) throw unavailable();
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: env().GOOGLE_CLIENT_ID!, client_secret: env().GOOGLE_CLIENT_SECRET!, redirect_uri: new URL("/auth/google/callback", authAppUrl()).toString(), grant_type: "authorization_code", code_verifier: flow.verifier }), signal: AbortSignal.timeout(10000), cache: "no-store", redirect: "error" });
    if (!response.ok) throw unavailable();
    const result = await response.json();
    if (typeof result.id_token !== "string") throw unavailable();
    return { ...await validateGoogleIdToken(result.id_token, flow.nonce), next: internalReturnPath(flow.next) };
  } catch { throw unavailable(); }
}
export async function findGoogleUser(db: Db, subject: string, email: string) {
  const user = await db.user.findUnique({ where: { googleSubject: subject } });
  if (user) { assertActive(user); if (env().NODE_ENV === "production" && user.isDemoAccount) throw unavailable(); return user; }
  if (await db.user.findUnique({ where: { email }, select: { id: true } })) throw new AppError("CONFLICT", "Este e-mail já possui uma conta. Entre usando sua senha; não vinculamos contas automaticamente.");
  return null;
}
