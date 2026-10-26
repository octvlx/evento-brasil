import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <p className="font-display text-6xl font-extrabold text-secondary">404</p>
      <h1 className="mt-2 font-display text-2xl font-bold">Página não encontrada</h1>
      <p className="mt-2 text-muted-foreground">O evento pode ter sido encerrado ou o endereço está incorreto.</p>
      <Link href="/eventos" className={buttonVariants({ variant: "secondary", className: "mt-6" })}>
        Explorar eventos
      </Link>
    </div>
  );
}
