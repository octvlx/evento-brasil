import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Conta excluída", robots: { index: false } };

export default function AccountDeletedPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-6">
      <h1 className="font-display text-3xl font-extrabold tracking-tight">Sua conta foi excluída</h1>
      <p className="mt-3 text-muted-foreground">
        Seus dados pessoais foram removidos e todas as sessões foram encerradas. Os registros das compras continuam guardados de forma anônima pelo prazo legal.
      </p>
      <Link href="/" className={buttonVariants({ className: "mt-6" })}>
        Voltar ao início
      </Link>
    </div>
  );
}
