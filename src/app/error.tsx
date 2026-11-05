"use client";

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center" role="alert">
      <h1 className="font-display text-2xl font-bold">Algo deu errado</h1>
      <p className="mt-2 text-muted-foreground">Não foi possível carregar esta página agora. Tente novamente em instantes.</p>
      {error.digest && <p className="mt-2 text-xs text-muted-foreground">Código do erro: {error.digest}</p>}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={() => reset()} className={buttonVariants({ variant: "default" })}>
          Tentar novamente
        </button>
        <Link href="/eventos" className={buttonVariants({ variant: "outline" })}>
          Explorar eventos
        </Link>
      </div>
    </div>
  );
}
