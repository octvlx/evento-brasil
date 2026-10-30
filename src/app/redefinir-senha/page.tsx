import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthShell } from "@/components/site/auth-shell";
import { Skeleton } from "@/components/ui/primitives";
import { ResetPasswordForm } from "@/features/auth/password-reset-forms";

export const metadata: Metadata = {
  title: "Redefinir senha",
  robots: { index: false },
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return (
    <AuthShell
      title="Redefinir senha"
      subtitle="Escolha uma nova senha para sua conta."
    >
      <Suspense fallback={<Skeleton className="h-64" />}>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
