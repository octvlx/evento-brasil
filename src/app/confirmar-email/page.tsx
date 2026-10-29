import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthShell } from "@/components/site/auth-shell";
import { Skeleton } from "@/components/ui/primitives";
import { getCurrentUser, safeNext } from "@/server/auth/current";
import { EmailConfirmationPanel } from "@/features/auth/verification-panels";
export const metadata: Metadata = { title: "Confirme seu e-mail", robots: { index: false }, referrer: "no-referrer" };
export default function EmailConfirmationPage({ searchParams }: PageProps<"/confirmar-email">) {
  return <AuthShell title="Confirme seu e-mail" subtitle="Mais segurança para suas compras."><Suspense fallback={<Skeleton className="h-48" />}><Content searchParams={searchParams} /></Suspense></AuthShell>;
}
async function Content({ searchParams }: { searchParams: PageProps<"/confirmar-email">["searchParams"] }) {
  const params = await searchParams; const user = await getCurrentUser();
  return <EmailConfirmationPanel next={safeNext(typeof params.next === "string" ? params.next : undefined)} email={user?.email ?? null} emailVerified={!!user?.emailVerifiedAt} />;
}
