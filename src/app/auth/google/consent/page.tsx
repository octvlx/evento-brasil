import { Suspense } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/site/auth-shell";
import { Skeleton } from "@/components/ui/primitives";
import { GOOGLE_PENDING_COOKIE, googleIdentitySchema, readGoogleCookie } from "@/server/auth/google";
import { GoogleSignupConsent } from "@/features/auth/verification-panels";
export default function GoogleConsentPage() {
  return <AuthShell title="Concluir cadastro" subtitle="Confirme seus termos antes de criar a conta."><Suspense fallback={<Skeleton className="h-48" />}><Content /></Suspense></AuthShell>;
}
async function Content() {
  const raw = (await cookies()).get(GOOGLE_PENDING_COOKIE)?.value;
  let identity;
  try { identity = googleIdentitySchema.parse(readGoogleCookie("pending", raw)); } catch { redirect("/entrar?googleError=unavailable"); }
  return <GoogleSignupConsent name={identity.name} email={identity.email} />;
}
